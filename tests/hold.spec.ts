import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { DecisionNotifier } from "../src/notifier.js";
import {
  AGENT_ID,
  APPROVAL_ID,
  approvalCreated,
  BASE_CONFIG,
  COMPANY_ID,
  event,
  INTERACTION_ID,
  interactionCreated,
  ISSUE_ID,
  issueUpdated,
  setup,
} from "./fixtures.js";

// Synthetic ids only.
const TRIAGE_AGENT_ID = "00000000-0000-4000-8000-0000000000d9";
const BLOCKED_ISSUE_ID = "00000000-0000-4000-8000-0000000000a7";
const TERMINAL_ID = "00000000-0000-4000-8000-0000000000a8";
const HOLD_MS = 120_000;
const HOLD_CONFIG = { ...BASE_CONFIG, triageAgentId: TRIAGE_AGENT_ID };

function holdSetup(config: Record<string, unknown> = HOLD_CONFIG) {
  const clock = { now: Date.parse("2026-01-02T10:00:00.000Z") };
  const timers: Array<{ fn: () => void; at: number }> = [];
  const timerOptions = {
    now: () => clock.now,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, at: clock.now + ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => {
      const index = timers.indexOf(handle as never);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  const s = setup({ config, notifier: timerOptions });
  s.harness.seed({
    issues: [
      { id: BLOCKED_ISSUE_ID, companyId: COMPANY_ID, identifier: "EX-7", title: "t", status: "blocked", unblockDescriptor: { owner: "board" }, blockedTransitionAt: "2026-01-02T09:00:00.000Z" } as never,
      { id: TERMINAL_ID, companyId: COMPANY_ID, identifier: "EX-8", title: "t", status: "in_progress" } as never,
    ],
    issueInteractions: [
      { id: INTERACTION_ID, companyId: COMPANY_ID, issueId: ISSUE_ID, kind: "connection_intent", status: "pending" } as never,
    ],
    approvals: [{ id: APPROVAL_ID, companyId: COMPANY_ID, status: "pending" } as never],
  });
  const settle = async () => {
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const advance = async (ms: number) => {
    clock.now += ms;
    for (;;) {
      const index = timers.findIndex((timer) => timer.at <= clock.now);
      if (index < 0) break;
      const [timer] = timers.splice(index, 1);
      timer.fn();
      await settle();
    }
    await settle();
  };
  return { ...s, clock, timers, advance };
}

function boardBlocked(): PluginEvent {
  return {
    ...issueUpdated({ status: "blocked", changes: { status: { from: "in_progress", to: "blocked" } } }, BLOCKED_ISSUE_ID),
    actorType: "system",
    actorId: undefined,
  };
}

function attentionEntered(): PluginEvent {
  return event("issue.blocker_attention_changed", {
    entityType: "issue",
    entityId: TERMINAL_ID,
    actorType: "system",
    actorId: undefined,
    payload: {
      terminalBlockerIssueId: TERMINAL_ID,
      dedupKey: `blocker:${TERMINAL_ID}`,
      entered: true,
      state: "stalled",
      blockingTreeLive: false,
      activityAt: "2026-01-02T10:00:00.000Z",
    },
  });
}

function connectionIntent(actorId = AGENT_ID): PluginEvent {
  return { ...interactionCreated({ interactionKind: "connection_intent", agentId: actorId }), actorId };
}

async function setInteractionStatus(s: ReturnType<typeof holdSetup>, status: string) {
  // The harness appends seeded cards, so update the stored card in place.
  const cards = await s.harness.ctx.issues.listInteractions(ISSUE_ID, COMPANY_ID);
  (cards.find((card) => card.id === INTERACTION_ID) as { status: string }).status = status;
}

describe("hold-until-triage", () => {
  it("stock config (no triageAgentId) pushes at once, exactly as 0.3.0", async () => {
    const s = holdSetup(BASE_CONFIG);
    await expect(s.notifier.handle(connectionIntent())).resolves.toBe("sent");
    expect(s.requests).toHaveLength(1);
  });

  it("holdNonTriageItems=false pushes at once even with a triage agent", async () => {
    const s = holdSetup({ ...HOLD_CONFIG, holdNonTriageItems: false });
    await expect(s.notifier.handle(connectionIntent())).resolves.toBe("sent");
  });

  it("triage-agent card pushes immediately", async () => {
    const s = holdSetup();
    await expect(s.notifier.handle(connectionIntent(TRIAGE_AGENT_ID))).resolves.toBe("sent");
    expect(s.requests).toHaveLength(1);
  });

  it.each([
    ["board-owned blocked issue (recovery-action substitute)", boardBlocked],
    ["blocked-dependency attention", attentionEntered],
    ["connection intent from another agent", () => connectionIntent()],
  ])("%s: held, then pushed when still open at expiry", async (_name, make) => {
    const s = holdSetup();
    await expect(s.notifier.handle(make())).resolves.toBe("held");
    await s.advance(HOLD_MS - 1);
    expect(s.requests).toHaveLength(0);
    await s.advance(1);
    expect(s.requests).toHaveLength(1);
  });

  it("missing creator is held (not treated as triage)", async () => {
    const s = holdSetup();
    const card = { ...interactionCreated({ agentId: undefined }), actorType: undefined, actorId: undefined };
    await expect(s.notifier.handle(card)).resolves.toBe("held");
  });

  it("held then cleared: card answered -> no push", async () => {
    const s = holdSetup();
    await s.notifier.handle(connectionIntent());
    await setInteractionStatus(s, "answered");
    await s.advance(HOLD_MS);
    expect(s.requests).toHaveLength(0);
  });

  it("held then cleared: approval decided -> no push; still pending -> push", async () => {
    const s = holdSetup();
    await s.notifier.handle(approvalCreated());
    s.harness.seed({ approvals: [{ id: APPROVAL_ID, companyId: COMPANY_ID, status: "approved" } as never] });
    await s.advance(HOLD_MS);
    expect(s.requests).toHaveLength(0);

    const t = holdSetup();
    await t.notifier.handle(approvalCreated());
    await t.advance(HOLD_MS);
    expect(t.requests).toHaveLength(1);
  });

  it("held then cleared: issue unblocked -> no push", async () => {
    const s = holdSetup();
    await s.notifier.handle(boardBlocked());
    s.harness.seed({ issues: [{ id: BLOCKED_ISSUE_ID, companyId: COMPANY_ID, identifier: "EX-7", title: "t", status: "in_progress" } as never] });
    await s.advance(HOLD_MS);
    expect(s.requests).toHaveLength(0);
  });

  it("held then cleared: attention item left the feed -> no push", async () => {
    const s = holdSetup();
    await s.notifier.handle(attentionEntered());
    await s.notifier.handle(
      event("issue.blocker_attention_changed", {
        entityType: "issue",
        entityId: TERMINAL_ID,
        actorType: "system",
        payload: { terminalBlockerIssueId: TERMINAL_ID, dedupKey: `blocker:${TERMINAL_ID}`, entered: false },
      }),
    );
    await s.advance(HOLD_MS);
    expect(s.requests).toHaveLength(0);
  });

  it("re-read fails -> push (fail open)", async () => {
    const s = holdSetup();
    await s.notifier.handle(connectionIntent());
    s.harness.ctx.issues.listInteractions = async () => {
      throw new Error("host unavailable");
    };
    await s.advance(HOLD_MS);
    expect(s.requests).toHaveLength(1);
  });

  it("restart mid-hold: the new worker re-arms the hold and pushes at expiry", async () => {
    const s = holdSetup();
    await s.notifier.handle(connectionIntent());
    s.notifier.stop();
    s.timers.splice(0);
    await s.advance(60_000);
    const restarted = s.makeNotifier();
    await restarted.start();
    expect(s.requests).toHaveLength(0);
    await s.advance(HOLD_MS - 60_000);
    expect(s.requests).toHaveLength(1);
  });

  it("overdue at startup -> push at once without a re-read", async () => {
    const s = holdSetup();
    await s.notifier.handle(connectionIntent());
    s.notifier.stop();
    s.timers.splice(0);
    await setInteractionStatus(s, "answered");
    s.clock.now += HOLD_MS * 5;
    const restarted: DecisionNotifier = s.makeNotifier();
    await restarted.start();
    expect(s.requests).toHaveLength(1);
  });

  it("dedupe: a replay while held or after the push does not push again", async () => {
    const s = holdSetup();
    const card = connectionIntent();
    await s.notifier.handle(card);
    await expect(s.notifier.handle({ ...card, eventId: "replay-1" })).resolves.toBe("duplicate");
    await s.advance(HOLD_MS);
    expect(s.requests).toHaveLength(1);
    await expect(s.notifier.handle({ ...card, eventId: "replay-2" })).resolves.toBe("duplicate");
    await s.advance(HOLD_MS);
    expect(s.requests).toHaveLength(1);
  });

  it("holdSeconds is honoured", async () => {
    const s = holdSetup({ ...HOLD_CONFIG, holdSeconds: 5 });
    await s.notifier.handle(connectionIntent());
    await s.advance(5_000);
    expect(s.requests).toHaveLength(1);
  });

  it("config read throws at release -> the hold is kept and retried, then pushes (fail open)", async () => {
    const s = holdSetup();
    await s.notifier.handle(connectionIntent());
    const realGet = s.harness.ctx.config.get.bind(s.harness.ctx.config);
    let failures = 2;
    s.harness.ctx.config.get = (async (...args: Parameters<typeof realGet>) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("config store unavailable");
      }
      return realGet(...args);
    }) as typeof s.harness.ctx.config.get;
    await s.advance(HOLD_MS);
    expect(s.requests).toHaveLength(0);
    const held = (await s.harness.ctx.state.get({ scopeKind: "instance", namespace: "ntfy-notifier", stateKey: "holds" })) as {
      holds: Array<{ retries?: number }>;
    };
    expect(held.holds).toHaveLength(1);
    expect(held.holds[0].retries).toBe(1);
    await s.advance(30_000);
    expect(s.requests).toHaveLength(0);
    await s.advance(60_000);
    expect(s.requests).toHaveLength(1);
    const after = (await s.harness.ctx.state.get({ scopeKind: "instance", namespace: "ntfy-notifier", stateKey: "holds" })) as {
      holds: unknown[];
    };
    expect(after.holds).toHaveLength(0);
  });

  it("a release run outside the timer clears the armed timer before re-arming", async () => {
    const s = holdSetup();
    await s.notifier.handle(connectionIntent());
    expect(s.timers).toHaveLength(1);
    await s.notifier.releaseDue();
    expect(s.timers).toHaveLength(1);
    await s.advance(HOLD_MS);
    expect(s.requests).toHaveLength(1);
    expect(s.timers).toHaveLength(0);
  });
});
