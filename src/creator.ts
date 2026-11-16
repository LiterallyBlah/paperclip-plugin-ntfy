/**
 * Who raised a decision item, judged from the host event alone.
 *
 * Field used per event kind (host 2026.1106.0):
 * - `issue.thread_interaction_created` (questions, confirmations, connection
 *   intents, tool-gateway cards): `event.actorType` / `event.actorId`. For an
 *   agent-created card the host also sets `payload.agentId` to the same id.
 * - `approval.created`, `decision.created`, `issue.updated`: activity-derived
 *   events. `event.actorType` / `event.actorId`, with `payload.agentId` as the
 *   agent that acted.
 * - `issue.blocker_attention_changed`: computed by the host, never raised by
 *   an agent. Always `system`.
 *
 * An item is "raised by triage" only when the creating actor is positively the
 * configured triage agent. Anything else, including an event that does not say
 * who acted, is not triage-raised: an unknown creator fails toward triage
 * (hold, then push if still open), never toward silence.
 */

import { BLOCKER_ATTENTION_CHANGED } from "./triggers.js";

export type RaisedBy =
  | { type: "agent"; agentId: string }
  | { type: "user" }
  | { type: "system" }
  | { type: "unknown" };

export interface CreatorEventLike {
  eventType: string;
  actorType?: string;
  actorId?: string;
  payload: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function raisedBy(event: CreatorEventLike): RaisedBy {
  if (event.eventType === BLOCKER_ATTENTION_CHANGED) return { type: "system" };
  const payload =
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const payloadAgentId = nonEmptyString(payload.agentId);
  switch (event.actorType) {
    case "agent": {
      const actorId = nonEmptyString(event.actorId);
      // Both fields must agree when both are present; a conflict is unknown.
      if (actorId && payloadAgentId && actorId !== payloadAgentId) return { type: "unknown" };
      const agentId = actorId ?? payloadAgentId;
      return agentId ? { type: "agent", agentId } : { type: "unknown" };
    }
    case "user":
      return { type: "user" };
    case "system":
    case "plugin":
      return { type: "system" };
    default:
      return { type: "unknown" };
  }
}

/** True only when the item was positively created by `triageAgentId`. */
export function isRaisedByTriage(event: CreatorEventLike, triageAgentId: string | null): boolean {
  if (!triageAgentId) return false;
  const who = raisedBy(event);
  return who.type === "agent" && who.agentId.toLowerCase() === triageAgentId.toLowerCase();
}
