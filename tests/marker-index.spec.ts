import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { MARKER_TTL_MS } from "../src/marker-index.js";
import { approvalCreated, COMPANY_ID, event, issueUpdated, setup } from "./fixtures.js";

// Synthetic ids only.
const BLOCKED_ISSUE_ID = "00000000-0000-4000-8000-0000000000a7";
const TERMINAL_ID = "00000000-0000-4000-8000-0000000000a8";
const OTHER_APPROVAL_ID = "00000000-0000-4000-8000-0000000000b2";
const DAY = 24 * 60 * 60 * 1000;

function markerSetup() {
  const clock = { now: Date.parse("2026-01-02T10:00:00.000Z") };
  const s = setup({ notifier: { now: () => clock.now } });
  s.harness.seed({
    issues: [
      { id: BLOCKED_ISSUE_ID, companyId: COMPANY_ID, identifier: "EX-7", title: "t", status: "blocked", unblockDescriptor: { owner: "board" }, blockedTransitionAt: "2026-01-02T09:00:00.000Z" } as never,
      { id: TERMINAL_ID, companyId: COMPANY_ID, identifier: "EX-8", title: "t", status: "in_progress" } as never,
    ],
  });
  const marker = (key: string) =>
    s.harness.ctx.state.get({ scopeKind: "company", scopeId: COMPANY_ID, namespace: "ntfy-notifier", stateKey: `sent:${key}` });
  return { ...s, clock, marker };
}

function boardBlocked(): PluginEvent {
  return {
    ...issueUpdated({ status: "blocked", changes: { status: { from: "in_progress", to: "blocked" } } }, BLOCKED_ISSUE_ID),
    actorType: "system",
    actorId: undefined,
  };
}

function attention(entered: boolean): PluginEvent {
  return event("issue.blocker_attention_changed", {
    entityType: "issue",
    entityId: TERMINAL_ID,
    actorType: "system",
    actorId: undefined,
    payload: { terminalBlockerIssueId: TERMINAL_ID, dedupKey: `blocker:${TERMINAL_ID}`, entered, state: "stalled", blockingTreeLive: false, activityAt: "2026-01-02T10:00:00.000Z" },
  });
}

describe("sent-marker pruning", () => {
  it("prunes a marker untouched for 30 days; a fresh one stays", async () => {
    const s = markerSetup();
    await s.notifier.handle(approvalCreated());
    s.clock.now += 20 * DAY;
    await s.notifier.handle(approvalCreated(undefined, OTHER_APPROVAL_ID));
    s.clock.now += 11 * DAY;
    await expect(s.notifier.markers.prune()).resolves.toBe(1);
    expect(await s.marker(`approval:${approvalCreated().entityId}`)).toBeNull();
    expect(await s.marker(`approval:${OTHER_APPROVAL_ID}`)).not.toBeNull();
  });

  it("a duplicate sighting refreshes the age, so an item that keeps producing events is never pruned", async () => {
    const s = markerSetup();
    await s.notifier.handle(approvalCreated());
    for (let i = 0; i < 4; i += 1) {
      s.clock.now += 10 * DAY;
      await expect(s.notifier.handle({ ...approvalCreated(), eventId: `replay-${i}` })).resolves.toBe("duplicate");
    }
    await expect(s.notifier.markers.prune()).resolves.toBe(0);
    await expect(s.notifier.handle({ ...approvalCreated(), eventId: "replay-last" })).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(1);
  });

  it("keeps a live human-owned block and an open feed episode past the age; prunes them once resolved", async () => {
    const s = markerSetup();
    await expect(s.notifier.handle(boardBlocked())).resolves.toBe("sent");
    await expect(s.notifier.handle(attention(true))).resolves.toBe("sent");
    s.clock.now += MARKER_TTL_MS + DAY;
    await expect(s.notifier.markers.prune()).resolves.toBe(0);
    // Dedupe for the live items still holds.
    await expect(s.notifier.handle({ ...boardBlocked(), eventId: "again" })).resolves.toBe("duplicate");
    expect(s.requests).toHaveLength(2);

    const issue = (await s.harness.ctx.issues.get(BLOCKED_ISSUE_ID, COMPANY_ID)) as { status: string };
    issue.status = "in_progress";
    await s.notifier.handle(attention(false));
    s.clock.now += MARKER_TTL_MS + DAY;
    await expect(s.notifier.markers.prune()).resolves.toBe(2);
  });

  it("start() prunes at most once a day; the index shrinks with pruned markers", async () => {
    const s = markerSetup();
    await s.notifier.handle(approvalCreated());
    s.clock.now += MARKER_TTL_MS + DAY;
    await s.makeNotifier({ now: () => s.clock.now }).start();
    expect(await s.marker(`approval:${approvalCreated().entityId}`)).toBeNull();
    const index = (await s.harness.ctx.state.get({ scopeKind: "instance", namespace: "ntfy-notifier", stateKey: "marker-index" })) as {
      entries: unknown[];
    };
    expect(index.entries).toHaveLength(0);
  });
});
