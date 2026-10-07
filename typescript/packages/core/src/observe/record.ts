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

import type { ByteSource } from '../io/types.ts'
import { VFSName } from '../types.ts'
import { underPath } from '../utils/key_prefix.ts'

// Ops whose record carries a token describing the bytes it moved, split
// by direction: the file cache stores bytes from either `IOResult.reads`
// or `IOResult.writes` and must ask about the side it took, since one
// line can carry both for a path.
//
// `create` and `truncate` stamp a token on their own record too, but
// neither ever hands bytes to the cache: no command builder can ask for
// a create (`Operation` has no member for it) and truncate's command
// returns an empty IOResult, so no created or truncated path is ever
// listed in `IOResult.cache`. A script runtime can still issue either
// through `RuntimeVFS`, and those ops bubble into the enclosing line's
// records, which is exactly why admitting them here could only pair one
// op's token with another op's bytes.
// 'append' is absent because no object store implements it and the
// backends that record one stamp no token.
// `truncate` would also need its record's `bytes` corrected before it
// could join: it reports 0 while its token describes `length` bytes, so
// the size check in `writtenVerdict` would refuse every one.
export const READ_FINGERPRINT_OPS: ReadonlySet<string> = new Set(['read'])
export const WRITE_FINGERPRINT_OPS: ReadonlySet<string> = new Set(['write'])

// What snapshot drift capture asks instead, and it is a different question
// from the cache's, so these are deliberately not the two sets above.
// `STAMP_FINGERPRINT_OPS` is a superset: capture reads the record, not the
// bytes, so it has none of the pairing problem that narrowed
// `WRITE_FINGERPRINT_OPS` to one member. The three overlap on purpose -- a
// write both describes and changes, and whether it carries a token is what
// tells capture which.
//
// All three hold the op names a `record()` call spells, not the op-table
// slots: the recursive delete is the `rm_recursive` slot but records as
// 'rm_r', and the rename op records as 'rename' or 'rename_prefix'
// depending on which of its two paths ran.
export const STAMP_FINGERPRINT_OPS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'create',
  'truncate',
])
export const CONTENT_CHANGING_OPS: ReadonlySet<string> = new Set([
  'write',
  'create',
  'truncate',
  'append',
  'pwrite',
])
export const RETRACT_FINGERPRINT_OPS: ReadonlySet<string> = new Set([
  'unlink',
  'rm_r',
  'rmdir',
  'rename',
  'rename_prefix',
  'copy',
])
// What a conditional write reads its version off, within the line: a record
// that stamps a token names the bytes now at its path, and one that retracts
// says the line no longer knows them (so the write asks for create-only,
// never for a version older than the line's own change).
export const VERSION_OPS: ReadonlySet<string> = new Set([
  ...STAMP_FINGERPRINT_OPS,
  ...RETRACT_FINGERPRINT_OPS,
])
// The subset that moved a whole prefix, and so takes every pin beneath
// it. Membership is what the op *did*, never what it could have done:
// rename has two code paths and only one of them is a prefix walk, so it
// spells them with two names. A point op must not take a subtree: it
// touched one key, and on a keyed store the keys beneath its path are
// objects of their own.
export const SUBTREE_RETRACT_OPS: ReadonlySet<string> = new Set(['rm_r', 'rename_prefix'])

/**
 * The newest record that says which version of `key` the line knows: one at
 * the path that stamps or retracts a version, or one at an ancestor that
 * moved the whole subtree, which took `key` with it. Mirrors python's
 * `newest_version`.
 */
export function newestVersion(records: readonly OpRecord[], key: string): OpRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]
    if (rec === undefined) continue
    if (rec.path === key && VERSION_OPS.has(rec.op)) return rec
    if (SUBTREE_RETRACT_OPS.has(rec.op) && underPath(key, rec.path)) return rec
  }
  return null
}

export interface OpRecordInit {
  op: string
  path: string
  source: string
  bytes: number
  timestamp: number
  durationMs: number
  /**
   * On a read, on an object store's write, create and truncate, and on a
   * Box, Dropbox or Google Drive write, the content-derived identifier the
   * backend returned (ETag, md5, Box sha1).
   * Captured as the op completes, so it describes the bytes that op
   * moved. Null for metadata ops and backends that return no token.
   */
  fingerprint?: string | null
  /**
   * Stable revision handle the backend returned (S3 VersionId, Drive
   * revisionId, Git SHA). Strictly stronger than fingerprint — populated
   * only by backends that can guarantee revision durability. Used by
   * replay to pin reads to the exact recorded version.
   */
  revision?: string | null
  /** In-process ownership for snapshot capture; not a persisted backend revision. */
  mountId?: string | null
  /**
   * The exact value the command that made this `write` put in
   * `IOResult.writes` for a path it claims, set by the executor and
   * cleared when the line ends. Internal: out of `toJSON`.
   */
  claimed?: ByteSource | null
  /**
   * Set when the line that persisted this record has ended, so a command
   * returning later cannot mark it. Internal: out of `toJSON`.
   */
  sealed?: boolean
}

export class OpRecord {
  readonly op: string
  readonly path: string
  readonly source: string
  bytes: number
  readonly timestamp: number
  durationMs: number
  fingerprint: string | null
  revision: string | null
  readonly mountId: string | null
  /** See {@link OpRecordInit.claimed}. */
  claimed: ByteSource | null
  /** See {@link OpRecordInit.sealed}. */
  sealed: boolean

  constructor(init: OpRecordInit) {
    this.op = init.op
    this.path = init.path
    this.source = init.source
    this.bytes = init.bytes
    this.timestamp = init.timestamp
    this.durationMs = init.durationMs
    this.fingerprint = init.fingerprint ?? null
    this.revision = init.revision ?? null
    this.mountId = init.mountId ?? null
    this.claimed = init.claimed ?? null
    this.sealed = init.sealed ?? false
  }

  get isCache(): boolean {
    return this.source === VFSName.RAM
  }

  toJSON(): Record<string, unknown> {
    return {
      op: this.op,
      path: this.path,
      source: this.source,
      bytes: this.bytes,
      timestamp: this.timestamp,
      durationMs: this.durationMs,
      fingerprint: this.fingerprint,
      revision: this.revision,
    }
  }
}
