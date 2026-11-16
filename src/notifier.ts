import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { parseConfig, type NotifierConfig } from "./config.js";
import { isRaisedByTriage } from "./creator.js";
import { DecisionDedupe, DEDUPE_NAMESPACE, type EpisodeMarker } from "./dedupe.js";
import { blockerIssueId, MarkerIndex, type MarkerRef } from "./marker-index.js";
import { buildClickUrl, buildMessageBody, buildMessageTitle, buildPublishUrl, MESSAGE_TAGS, type MessageTarget } from "./message.js";
import { sendNtfy, type FetchLike } from "./ntfy.js";
import {
  BLOCKER_ATTENTION_CHANGED,
  blockerDecisionKey,
  blockerTreeEpisodeKey,
  classifyEvent,
  interactionRouting,
  isHumanOwnedBlocker,
  type DecisionCandidate,
  type InteractionRouting,
  type IssueBlockerView,
} from "./triggers.js";

export interface NotifierOptions {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Override for tests; defaults to the host-mediated `ctx.http.fetch`. */
  fetch?: FetchLike;
  /** Clock and timer overrides for tests (hold-until-triage). */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * A push held until the triage window ends. Persisted (instance scope) so a
 * hold survives a plugin restart. Carries ids only, never text.
 */
export interface HeldPush {
  companyId: string;
  key: string;
  mode: "once" | "episode";
  candidate: DecisionCandidate;
  dueAt: number;
  /** Release attempts that ended in an error (0.4.1+; absent means 0). */
  retries?: number;
}

interface HoldState {
  v: 1;
  holds: HeldPush[];
}

/** Upper bound on persisted holds; beyond it items push at once (fail open). */
export const MAX_HOLDS = 500;

/** Retry delay for a hold whose release failed: 30 s doubling, at most 15 min. */
export const HOLD_RETRY_BASE_MS = 30_000;
export const HOLD_RETRY_MAX_MS = 15 * 60_000;

interface ResolvedDecision {
  key: string;
  issue: { identifier?: string | null } | null;
  /** `once` (default): one push per key. `episode`: one push per open feed episode. `close`: end the episode. */
  mode?: "once" | "episode" | "close";
}

export const DEFAULT_NOTIFIER_OPTIONS: NotifierOptions = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  retryDelayMs: 500,
};

export type NotifyOutcome =
  | "ignored"
  | "not_configured"
  | "not_eligible"
  | "addressee_unknown"
  | "episode_closed"
  | "duplicate"
  | "sent"
  | "send_failed"
  | "token_unavailable"
  | "held"
  | "hold_cleared"
  | "error";

/**
 * Handles one host event end to end. Never throws: an event handler failure
 * must not affect the host or other plugins. Log lines carry only coarse
 * outcome codes, never identifiers, URLs, tokens or event text.
 */
export class DecisionNotifier {
  private readonly dedupe: DecisionDedupe;
  /** Age-based pruning of the per-item sent markers. Exposed for tests. */
  readonly markers: MarkerIndex;
  /** Tail of the handler chain per company and feed key; see `handle`. */
  private readonly feedQueue = new Map<string, Promise<unknown>>();
  private holdLock: Promise<unknown> = Promise.resolve();
  private holdTimer: unknown = null;
  private holdTimerDueAt: number | null = null;

  constructor(
    private readonly ctx: PluginContext,
    private readonly options: NotifierOptions = DEFAULT_NOTIFIER_OPTIONS,
  ) {
    this.markers = new MarkerIndex(ctx.state, DEDUPE_NAMESPACE, {
      now: () => this.now(),
      keep: (ref, value) => this.markerStillLive(ref, value),
    });
    this.dedupe = new DecisionDedupe(ctx.state, this.markers);
  }

  /**
   * A marker past its age is kept while its item is still live: an open feed
   * episode, or a human-owned block that has not changed since the push.
   */
  private async markerStillLive(ref: MarkerRef, value: unknown): Promise<boolean> {
    if ((value as EpisodeMarker | null)?.open === true) return true;
    const key = ref.stateKey.startsWith("sent:") ? ref.stateKey.slice("sent:".length) : ref.stateKey;
    const issueId = blockerIssueId(key);
    if (!issueId) return false;
    const issue = (await this.ctx.issues.get(issueId, ref.companyId)) as IssueBlockerView | null;
    return !!issue && isHumanOwnedBlocker(issue) && blockerDecisionKey(issueId, issue) === key;
  }

  /**
   * Feed events (computed blocker attention) for one company and feed key are
   * handled strictly in arrival order, from handler entry, before any
   * asynchronous wait (configuration, issue lookup, send). Without this an exit
   * could finish while the matching entry still waits on its issue lookup,
   * close nothing, and let the late entry leave an open episode that hides the
   * next legitimate entry. The host forwards events without awaiting handlers,
   * so they can overlap. Events for other keys, and all other event kinds, are
   * not queued and run independently.
   */
  handle(event: PluginEvent): Promise<NotifyOutcome> {
    const orderKey = feedOrderKey(event);
    if (orderKey === null) return this.process(event);
    const previous = this.feedQueue.get(orderKey) ?? Promise.resolve();
    const run = () => this.process(event);
    const result = previous.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.feedQueue.set(orderKey, tail);
    void tail.then(() => {
      if (this.feedQueue.get(orderKey) === tail) this.feedQueue.delete(orderKey);
    });
    return result;
  }

  private async process(event: PluginEvent): Promise<NotifyOutcome> {
    let kind: DecisionCandidate["kind"] | "unknown" = "unknown";
    try {
      const config = await this.loadConfig(event.companyId);
      if (!config) return "not_configured";

      const candidate = classifyEvent(event, config.triggers);
      if (!candidate) return "ignored";
      kind = candidate.kind;

      const decision = await this.resolveDecisionKey(candidate);
      if (decision === "addressee_unknown") return this.log(kind, "addressee_unknown");
      if (!decision) return this.log(kind, "not_eligible");
      const key = { companyId: candidate.companyId, key: decision.key };
      if (decision.mode === "close") {
        await this.dedupe.closeEpisode(key);
        // The item left the feed while held: it is no longer waiting, so the hold ends without a push.
        await this.cancelHold(candidate.companyId, decision.key);
        return this.log(kind, "episode_closed");
      }

      // Hold-until-triage: only with a triage agent set; its own items push at once.
      if (config.triageAgentId && config.holdNonTriageItems && !isRaisedByTriage(event, config.triageAgentId)) {
        const held = await this.hold(config, {
          companyId: candidate.companyId,
          key: decision.key,
          mode: decision.mode === "episode" ? "episode" : "once",
          candidate,
          dueAt: 0,
        });
        if (held !== "push_now") return this.log(kind, held);
      }

      let sendOutcome: NotifyOutcome = "send_failed";
      const send = async () => {
        sendOutcome = await this.send(config, candidate, decision.issue);
        return sendOutcome === "sent";
      };
      const result = decision.mode === "episode" ? await this.dedupe.runEpisode(key, send) : await this.dedupe.runOnce(key, send);
      if (result === "duplicate") return this.log(kind, "duplicate");
      return this.log(kind, sendOutcome);
    } catch (error) {
      // Only the error class name is logged: messages can embed URLs.
      this.ctx.logger.warn("ntfy notifier: event handling failed", {
        kind,
        outcome: "error",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return "error";
    }
  }

  private log(kind: string, outcome: NotifyOutcome): NotifyOutcome {
    const meta = { kind, outcome };
    if (outcome === "sent") this.ctx.logger.info("ntfy notifier: decision notification sent", meta);
    else if (outcome === "send_failed" || outcome === "token_unavailable" || outcome === "addressee_unknown") {
      this.ctx.logger.warn("ntfy notifier: decision notification not sent", meta);
    } else this.ctx.logger.debug("ntfy notifier: decision skipped", meta);
    return outcome;
  }

  private async loadConfig(companyId: string): Promise<NotifierConfig | null> {
    const raw = await this.ctx.config.get(companyId);
    if (!raw || Object.keys(raw).length === 0) return null;
    const parsed = parseConfig(raw);
    if (!parsed.ok) {
      this.ctx.logger.warn("ntfy notifier: config is invalid; notifications are off", {
        errorCount: parsed.errors.length,
      });
      return null;
    }
    return parsed.config;
  }

  private async resolveDecisionKey(
    candidate: DecisionCandidate,
  ): Promise<ResolvedDecision | "addressee_unknown" | null> {
    switch (candidate.kind) {
      case "approval":
        return {
          key: candidate.toolActionRequestId
            ? `tool-action:${candidate.toolActionRequestId}`
            : `approval:${candidate.approvalId}`,
          issue: null,
        };
      case "interaction": {
        if (candidate.routing === "unknown") {
          const routing = await this.resolveInteractionRouting(candidate);
          if (routing === "unknown") return "addressee_unknown";
          if (routing !== "human") return null;
        }
        return {
          key: candidate.toolActionRequestId
            ? `tool-action:${candidate.toolActionRequestId}`
            : `interaction:${candidate.interactionId}`,
          issue: null,
        };
      }
      case "blocker": {
        const issue = (await this.ctx.issues.get(candidate.issueId, candidate.companyId)) as
          | (IssueBlockerView & { identifier?: string | null })
          | null;
        // An issue the plugin may not read cannot be confirmed as human-owned.
        if (!issue || !isHumanOwnedBlocker(issue)) return null;
        return { key: blockerDecisionKey(candidate.issueId, issue), issue };
      }
      case "blocker_tree": {
        const episode = blockerTreeEpisodeKey(candidate.dedupKey);
        if (candidate.phase === "exit") return { key: episode, issue: null, mode: "close" };
        // The feed item's subject is its terminal blocker (`blocker:<issueId>`). When that terminal
        // issue is itself blocked with a human-owned unblock step, the item is the same decision as
        // the human-owned blocked push (the feed also lists it as `blocked-owner:`), so it shares the
        // human-owned key and gets one push. This depends only on the terminal issue, never on which
        // downstream issue the host chose as `blockedIssueId` (the group's most recently updated one).
        const terminal = (await this.ctx.issues.get(candidate.issueId, candidate.companyId).catch(() => null)) as
          | (IssueBlockerView & { identifier?: string | null })
          | null;
        if (terminal && isHumanOwnedBlocker(terminal)) return { key: blockerDecisionKey(candidate.issueId, terminal), issue: terminal };
        return { key: episode, issue: null, mode: "episode" };
      }
      case "decision":
        return { key: `decision:${candidate.decisionId}`, issue: null };
    }
  }

  // ---- hold-until-triage -------------------------------------------------

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private holdExclusive<T>(op: () => Promise<T>): Promise<T> {
    const result = this.holdLock.then(op, op);
    this.holdLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private holdScope() {
    return { scopeKind: "instance" as const, namespace: DEDUPE_NAMESPACE, stateKey: "holds" };
  }

  private async loadHolds(): Promise<HeldPush[]> {
    const raw = (await this.ctx.state.get(this.holdScope())) as HoldState | null | undefined;
    return raw && raw.v === 1 && Array.isArray(raw.holds) ? raw.holds : [];
  }

  private async saveHolds(holds: HeldPush[]): Promise<void> {
    await this.ctx.state.set(this.holdScope(), { v: 1, holds } satisfies HoldState);
  }

  /** Persist a hold. Returns `push_now` when the item cannot be held (fail open). */
  private hold(config: NotifierConfig, item: HeldPush): Promise<NotifyOutcome | "push_now"> {
    return this.holdExclusive(async (): Promise<NotifyOutcome | "push_now"> => {
      try {
        if (await this.dedupe.alreadySent({ companyId: item.companyId, key: item.key }, item.mode)) return "duplicate";
        const holds = await this.loadHolds();
        if (holds.some((entry) => entry.companyId === item.companyId && entry.key === item.key)) return "duplicate";
        if (holds.length >= MAX_HOLDS) return "push_now";
        holds.push({ ...item, dueAt: this.now() + config.holdSeconds * 1000 });
        await this.saveHolds(holds);
        this.scheduleHolds(holds);
        return "held";
      } catch {
        return "push_now";
      }
    });
  }

  private cancelHold(companyId: string, key: string): Promise<void> {
    return this.holdExclusive(async () => {
      const holds = await this.loadHolds();
      const kept = holds.filter((entry) => !(entry.companyId === companyId && entry.key === key));
      if (kept.length === holds.length) return;
      await this.saveHolds(kept);
      this.scheduleHolds(kept);
    });
  }

  /**
   * Resume persisted holds after a restart. Holds that are already overdue are
   * pushed at once without a re-read (fail open); the rest are re-armed.
   */
  async start(): Promise<void> {
    await this.releaseDue({ reRead: false });
    await this.markers.maybePrune();
  }

  stop(): void {
    if (this.holdTimer !== null) (this.options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.holdTimer);
    this.holdTimer = null;
    this.holdTimerDueAt = null;
  }

  private scheduleHolds(holds: HeldPush[]): void {
    if (holds.length === 0) {
      this.stop();
      return;
    }
    const due = Math.min(...holds.map((entry) => entry.dueAt));
    if (this.holdTimer !== null && this.holdTimerDueAt !== null && this.holdTimerDueAt <= due) return;
    this.stop();
    const setTimer =
      this.options.setTimer ??
      ((fn: () => void, ms: number) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.holdTimerDueAt = due;
    this.holdTimer = setTimer(() => {
      this.holdTimer = null;
      this.holdTimerDueAt = null;
      void this.releaseDue({ reRead: true });
    }, Math.max(0, due - this.now()));
  }

  /**
   * End every due hold: re-read the item and push only if it is still open.
   * A failed re-read pushes. A hold is removed only after its push attempt, so
   * a restart in between pushes again, and the sent marker absorbs a repeat.
   * Exposed for tests; normally run by the timer.
   */
  releaseDue(options: { reRead: boolean } = { reRead: true }): Promise<Array<{ key: string; outcome: NotifyOutcome }>> {
    return this.holdExclusive(async () => {
      const results: Array<{ key: string; outcome: NotifyOutcome }> = [];
      let holds: HeldPush[];
      try {
        holds = await this.loadHolds();
      } catch {
        return results;
      }
      const now = this.now();
      for (const item of holds.filter((entry) => entry.dueAt <= now)) {
        const outcome = await this.releaseOne(item, options.reRead).catch((): NotifyOutcome => "error");
        results.push({ key: item.key, outcome });
        this.log(item.candidate.kind, outcome);
        if (outcome === "error") {
          // Fail open: the release could not run (for example the config read
          // threw). Keep the hold and try again later instead of dropping it.
          const retries = (item.retries ?? 0) + 1;
          const delay = Math.min(HOLD_RETRY_BASE_MS * 2 ** Math.min(retries - 1, 10), HOLD_RETRY_MAX_MS);
          holds = holds.map((entry) => (entry === item ? { ...item, retries, dueAt: now + delay } : entry));
          this.ctx.logger.warn("ntfy notifier: held push not released; will retry", { kind: item.candidate.kind, retries });
        } else {
          holds = holds.filter((entry) => entry !== item);
        }
        await this.saveHolds(holds).catch(() => undefined);
      }
      // Clear any armed timer before re-arming (this run may not be the timer's).
      this.stop();
      this.scheduleHolds(holds);
      return results;
    });
  }

  private async releaseOne(item: HeldPush, reRead: boolean): Promise<NotifyOutcome> {
    const config = await this.loadConfig(item.companyId);
    if (!config) return "not_configured";
    if (reRead && !(await this.stillOpen(item).catch(() => true))) return "hold_cleared";
    let sendOutcome: NotifyOutcome = "send_failed";
    const send = async () => {
      sendOutcome = await this.send(config, item.candidate, null);
      return sendOutcome === "sent";
    };
    const key = { companyId: item.companyId, key: item.key };
    const result = item.mode === "episode" ? await this.dedupe.runEpisode(key, send) : await this.dedupe.runOnce(key, send);
    return result === "duplicate" ? "duplicate" : sendOutcome;
  }

  /**
   * Whether a held item still waits for a person. Anything that cannot be
   * confirmed as resolved counts as open (push).
   */
  private async stillOpen(item: HeldPush): Promise<boolean> {
    const candidate = item.candidate;
    switch (candidate.kind) {
      case "approval": {
        const approval = (await this.ctx.approvals.get(candidate.approvalId, candidate.companyId)) as { status?: unknown } | null;
        if (!approval) return true;
        return !["approved", "rejected", "cancelled", "revision_requested"].includes(String(approval.status));
      }
      case "interaction": {
        const cards = await this.ctx.issues.listInteractions(candidate.issueId, candidate.companyId);
        const card = cards.find((entry) => entry.id === candidate.interactionId) as { status?: unknown } | undefined;
        return !card || card.status === "pending";
      }
      case "blocker":
      case "blocker_tree": {
        // Feed episodes end through the exit event, which cancels the hold.
        if (item.mode === "episode") return true;
        const issue = (await this.ctx.issues.get(candidate.issueId, candidate.companyId)) as IssueBlockerView | null;
        if (!issue) return true;
        return isHumanOwnedBlocker(issue) && blockerDecisionKey(candidate.issueId, issue) === item.key;
      }
      case "decision":
        // No plugin read surface for board decisions: push.
        return true;
    }
  }

  /**
   * The event did not say who the card is for. Read the card through the
   * supported `issue.interactions.read` capability. If it cannot be read (for
   * example a private issue), the addressee stays unknown and nothing is sent.
   */
  private async resolveInteractionRouting(
    candidate: Extract<DecisionCandidate, { kind: "interaction" }>,
  ): Promise<InteractionRouting> {
    const cards = await this.ctx.issues
      .listInteractions(candidate.issueId, candidate.companyId)
      .catch(() => null);
    const card = cards?.find((entry) => entry.id === candidate.interactionId) as
      | { status?: unknown; addresseeAgentId?: unknown }
      | undefined;
    if (!card) return "unknown";
    return interactionRouting({ interactionStatus: card.status, addresseeAgentId: card.addresseeAgentId ?? null });
  }

  private async target(
    candidate: DecisionCandidate,
    knownIssue: { identifier?: string | null } | null,
  ): Promise<MessageTarget> {
    const company = await this.ctx.companies.get(candidate.companyId).catch(() => null);
    const issueId = candidate.issueId;
    let identifier = knownIssue?.identifier ?? null;
    if (!identifier && issueId) {
      // Private issues the plugin may not read return null; the link then
      // falls back to the issue UUID and the body carries no identifier.
      const issue = await this.ctx.issues.get(issueId, candidate.companyId).catch(() => null);
      identifier = issue?.identifier ?? null;
    }
    return {
      issuePrefix: company?.issuePrefix ?? null,
      issueIdentifier: identifier,
      issueId,
      approvalId: candidate.kind === "approval" ? candidate.approvalId : null,
      decisionId: candidate.kind === "decision" ? candidate.decisionId : null,
      // Only when no issue is linked; an unreadable linked issue keeps the bare sentence.
      fallbackLabel: issueId ? null : candidate.kind === "approval" ? "approval" : candidate.kind === "decision" ? "decision" : null,
    };
  }

  private async send(
    config: NotifierConfig,
    candidate: DecisionCandidate,
    knownIssue: { identifier?: string | null } | null,
  ): Promise<NotifyOutcome> {
    let token: string | undefined;
    if (config.tokenSecretRef) {
      try {
        token = await this.ctx.secrets.resolve(config.tokenSecretRef as never);
      } catch {
        return "token_unavailable";
      }
      if (!token) return "token_unavailable";
    }
    const target = await this.target(candidate, knownIssue);
    const result = await sendNtfy(
      {
        url: buildPublishUrl(config.ntfyBaseUrl, config.topic),
        body: buildMessageBody(target),
        click: buildClickUrl(config.paperclipBaseUrl, target),
        title: buildMessageTitle(target),
        tags: MESSAGE_TAGS,
        token,
        priority: config.priority ?? undefined,
      },
      {
        fetch: this.options.fetch ?? ((url, init) => this.ctx.http.fetch(url, init)),
        timeoutMs: this.options.timeoutMs,
        maxAttempts: this.options.maxAttempts,
        retryDelayMs: this.options.retryDelayMs,
        sleep: this.options.sleep,
      },
    );
    if (!result.ok) {
      this.ctx.logger.warn("ntfy notifier: publish failed", {
        kind: candidate.kind,
        reason: result.reason,
        status: result.status ?? null,
        attempts: result.attempts,
      });
      return "send_failed";
    }
    return "sent";
  }
}

/**
 * Synchronous ordering key for a computed blocker attention event: company and
 * the feed's raw `dedupKey`. Read before any await so that arrival order is
 * kept. Other events return `null` and are not ordered.
 */
function feedOrderKey(event: PluginEvent): string | null {
  if ((event.eventType as string) !== BLOCKER_ATTENTION_CHANGED) return null;
  const payload = event.payload as { dedupKey?: unknown } | null | undefined;
  const dedupKey = payload && typeof payload === "object" ? payload.dedupKey : undefined;
  if (typeof dedupKey !== "string" || dedupKey.length === 0) return null;
  return `${event.companyId}\u0000${dedupKey}`;
}
