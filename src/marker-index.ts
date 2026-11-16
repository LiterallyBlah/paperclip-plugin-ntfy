import type { PluginStateClient } from "@paperclipai/plugin-sdk";

/**
 * Age-based pruning for per-item dedupe markers.
 *
 * The host state API has no list operation, so markers cannot be enumerated.
 * This keeps a small instance-scope index of the markers this worker wrote or
 * saw, with the time each one was last touched. A marker is touched when it is
 * written and again when a later event for the same item is absorbed as a
 * duplicate (at most once per `refreshMs`), so an item that keeps producing
 * events is never pruned.
 *
 * `prune` deletes a marker only when it has not been touched for `ttlMs` and
 * the caller's `keep` check does not report the item as still live. A failed
 * `keep` check keeps the marker. The index itself shrinks with every pruned
 * marker, so its size follows the number of items seen in the last `ttlMs`.
 *
 * Markers written before this index existed are added the first time an event
 * for their item is absorbed as a duplicate; until then they are not pruned.
 */

export const MARKER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MARKER_REFRESH_MS = 24 * 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MarkerRef {
  companyId: string;
  /** Full state key of the marker (company scope, the plugin's namespace). */
  stateKey: string;
}

interface IndexEntry {
  c: string;
  k: string;
  t: number;
}

interface IndexState {
  v: 1;
  entries: IndexEntry[];
  prunedAt: number;
}

export interface MarkerIndexOptions {
  now: () => number;
  ttlMs?: number;
  refreshMs?: number;
  pruneIntervalMs?: number;
  /** Return true to keep a marker that is past its age (the item is still live). */
  keep?: (ref: MarkerRef, value: unknown) => Promise<boolean>;
}

export class MarkerIndex {
  private cache: IndexState | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly ttlMs: number;
  private readonly refreshMs: number;
  private readonly pruneIntervalMs: number;

  constructor(
    private readonly state: PluginStateClient,
    private readonly namespace: string,
    private readonly options: MarkerIndexOptions,
  ) {
    this.ttlMs = options.ttlMs ?? MARKER_TTL_MS;
    this.refreshMs = options.refreshMs ?? MARKER_REFRESH_MS;
    this.pruneIntervalMs = options.pruneIntervalMs ?? PRUNE_INTERVAL_MS;
  }

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const result = this.lock.then(op, op);
    this.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private scope() {
    return { scopeKind: "instance" as const, namespace: this.namespace, stateKey: "marker-index" };
  }

  private markerScope(ref: MarkerRef) {
    return { scopeKind: "company" as const, scopeId: ref.companyId, namespace: this.namespace, stateKey: ref.stateKey };
  }

  private async load(): Promise<IndexState> {
    if (this.cache) return this.cache;
    const raw = (await this.state.get(this.scope())) as IndexState | null | undefined;
    this.cache =
      raw && raw.v === 1 && Array.isArray(raw.entries)
        ? { v: 1, entries: raw.entries, prunedAt: typeof raw.prunedAt === "number" ? raw.prunedAt : 0 }
        : { v: 1, entries: [], prunedAt: 0 };
    return this.cache;
  }

  private async save(index: IndexState): Promise<void> {
    await this.state.set(this.scope(), index);
  }

  /**
   * Record that a marker was written or seen now. `written` forces an update;
   * a duplicate sighting only refreshes an entry older than `refreshMs`.
   * Never throws: the index is housekeeping and must not affect delivery.
   */
  touch(ref: MarkerRef, written: boolean): Promise<void> {
    return this.exclusive(async () => {
      try {
        const index = await this.load();
        const now = this.options.now();
        const entry = index.entries.find((item) => item.c === ref.companyId && item.k === ref.stateKey);
        if (entry) {
          if (!written && now - entry.t < this.refreshMs) return;
          entry.t = now;
        } else {
          index.entries.push({ c: ref.companyId, k: ref.stateKey, t: now });
        }
        await this.save(index);
      } catch {
        // housekeeping only
      }
    }).then(async () => {
      await this.maybePrune();
    });
  }

  /** Prune when the last prune is older than the prune interval. Never throws. */
  maybePrune(): Promise<number> {
    return this.exclusive(async () => {
      try {
        const index = await this.load();
        if (this.options.now() - index.prunedAt < this.pruneIntervalMs) return 0;
        return await this.pruneLocked(index);
      } catch {
        return 0;
      }
    });
  }

  /** Prune now. Returns the number of markers deleted. Exposed for tests. */
  prune(): Promise<number> {
    return this.exclusive(async () => this.pruneLocked(await this.load()));
  }

  private async pruneLocked(index: IndexState): Promise<number> {
    const now = this.options.now();
    let deleted = 0;
    const kept: IndexEntry[] = [];
    for (const entry of index.entries) {
      if (now - entry.t < this.ttlMs) {
        kept.push(entry);
        continue;
      }
      const ref = { companyId: entry.c, stateKey: entry.k };
      try {
        const value = await this.state.get(this.markerScope(ref));
        if (value === null || value === undefined) continue;
        if (this.options.keep && (await this.options.keep(ref, value).catch(() => true))) {
          kept.push({ ...entry, t: now });
          continue;
        }
        await this.state.delete(this.markerScope(ref));
        deleted += 1;
      } catch {
        kept.push(entry);
      }
    }
    index.entries = kept;
    index.prunedAt = now;
    await this.save(index).catch(() => undefined);
    return deleted;
  }
}

/** `blocker:<issueId>:<stamp>` -> issue id, else null. */
export function blockerIssueId(key: string): string | null {
  if (!key.startsWith("blocker:")) return null;
  const end = key.indexOf(":", "blocker:".length);
  return end > "blocker:".length ? key.slice("blocker:".length, end) : null;
}
