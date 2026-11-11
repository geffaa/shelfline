import type { Command, CommandResult, PullResponse, PushRequest, PushResponse, ReplicaItem, SnapshotResponse } from "@shelfline/contracts";

export interface RejectionRecord { id: string; seq: number; type: string; reason: string; detail?: unknown; at: string; payload: unknown }
export interface FlaggedRecord { id: string; seq: number; type: string; flags: string[]; at: string }

/**
 * Local persistence for a POS. One contract, several adapters (Dexie/IndexedDB in the PWA, SQLite under Capacitor in P2, in-memory for tests).
 * Everything that must be atomic (a finished sale AND its queued command) goes through transact().
 */
export interface StoreTx {
  /** Assigns the next gapless device sequence and a UUIDv7 id. */
  enqueue(c: { type: string; payload: unknown; actorId: string; clientTs?: string; schemaV: number }): Promise<Command>;
  /** Removes acknowledged commands from the outbox. Rejected and flagged ones are kept as records for the Sync screen. */
  ack(results: CommandResult[], commands: Command[], at: string): Promise<void>;
  applyItems(items: ReplicaItem[]): Promise<void>;
  setMeta(key: string, value: string): Promise<void>;
  put(ns: string, key: string, value: unknown): Promise<void>;
  del(ns: string, key: string): Promise<void>;
  /** Moves the next sequence forward (adopting the server's expectation after local storage was lost). */
  setNextSeq(seq: number): Promise<void>;
  /** Reads inside the transaction (a receipt counter must be read and bumped atomically). */
  getMeta(key: string): Promise<string | undefined>;
  get<T = unknown>(ns: string, key: string): Promise<T | undefined>;
}
export interface LocalStore {
  transact<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  pendingCommands(limit: number): Promise<Command[]>;
  pendingCount(): Promise<number>;
  nextSeq(): Promise<number>;
  getMeta(key: string): Promise<string | undefined>;
  get<T = unknown>(ns: string, key: string): Promise<T | undefined>;
  list<T = unknown>(ns: string): Promise<{ key: string; value: T }[]>;
  rejections(): Promise<RejectionRecord[]>;
  flagged(): Promise<FlaggedRecord[]>;
  close(): Promise<void>;
}

export interface StatusResponse { deviceId: string; lastSeq: number; expectedSeq: number; clockSkewMs: number | null; serverTime: string; schemaV: number; minSchemaV: number }
export interface Transport {
  push(req: PushRequest): Promise<PushResponse>;
  pull(cursor: string, limit?: number): Promise<PullResponse>;
  snapshot(after: string | null): Promise<SnapshotResponse>;
  status(): Promise<StatusResponse>;
}
export class NetworkError extends Error { constructor(m: string) { super(m); this.name = "NetworkError"; } }
export class AuthError extends Error { constructor(public status: number) { super(`auth ${status}`); this.name = "AuthError"; } }
export class ProtocolError extends Error { constructor(public status: number, public body: unknown) { super(`protocol ${status}`); this.name = "ProtocolError"; } }

/**
 * What actually happened to a command, seeing through `duplicate`: when a response is lost the device resends, and the server answers
 * `duplicate` carrying the original outcome. A rejection or a flag must still reach the Sync screen, not vanish with the lost response.
 */
export function effectiveStatus(r: { status: string; detail?: unknown }): "accepted" | "accepted_flagged" | "rejected" | "gap" {
  if (r.status === "duplicate") { const o = (r.detail as { original?: string } | undefined)?.original; return o === "rejected" || o === "accepted_flagged" ? o : "accepted"; }
  return r.status as "accepted" | "accepted_flagged" | "rejected" | "gap";
}
