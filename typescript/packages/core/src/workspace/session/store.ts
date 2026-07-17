// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

// One session's durable fields: the JSON-able `Session.toJSON()` payload
// (session_id, cwd, env, created_at, mount_modes — snake_case so Python
// and TypeScript workspaces can share one store). Volatile shell state
// (functions, arrays, stdin buffers) never persists.
export type SessionFields = Record<string, unknown>

// Shared cap for every generation-CAS retry loop (session flush,
// workspace meta): losing this many times in a row on a rarely written
// record is a bug to surface, not contention to absorb.
export const CAS_MAX_RETRIES = 3

/**
 * A stored record's CAS generation; a missing record or a legacy
 * record without the field counts as 0.
 */
export function generationOf(fields: Record<string, unknown> | null | undefined): number {
  if (fields === null || fields === undefined) return 0
  return Number(fields.generation ?? 0)
}

/**
 * Storage seam for durable session state. Abstract base.
 *
 * Mirrors the NamespaceStore pattern: the SessionManager keeps the
 * working copy in memory, hydrates once from the store, and writes
 * through on mutation, so sessions (and the mount grants they carry)
 * survive process restarts and are visible to any workspace pointed at
 * the same store. RAM is the default; Redis (node package) shares
 * sessions across processes, which is what lets a kernel tier bind a
 * session-bound mountpoint created by another daemon.
 */
export abstract class SessionStore {
  // Read every stored session, keyed by session id (hydration at first use).
  abstract load(): Promise<Map<string, SessionFields>>
  // Insert or update one session's fields.
  abstract set(sessionId: string, fields: SessionFields): Promise<void>
  /**
   * Write one session iff its stored generation matches.
   *
   * Optimistic concurrency for the flush path: the write succeeds only
   * when the stored record's `generation` equals `expectedGeneration`
   * (a missing record and a record without the field both count as
   * generation 0). `replaceAll` stays unchecked on purpose: a snapshot
   * restore wins wholesale. Resolves true when the write landed, false
   * on conflict.
   */
  abstract casSet(
    sessionId: string,
    fields: SessionFields,
    expectedGeneration: number,
  ): Promise<boolean>
  // Remove the given sessions; missing ids are ignored.
  abstract delete(sessionIds: readonly string[]): Promise<void>
  // Replace the full session table (snapshot restore).
  abstract replaceAll(entries: Map<string, SessionFields>): Promise<void>
  // Drop all stored sessions.
  abstract clear(): Promise<void>
  // Release any underlying connections.
  abstract close(): Promise<void>
}
