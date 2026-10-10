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
// through `RuntimeFiles`, and those ops bubble into the enclosing line's
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
// 'rm_r', the rename op records as 'rename' or 'rename_prefix'
// depending on which of its two paths ran, and a copy of a whole folder in
// one request as 'copy_prefix'.
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
  'copy_prefix',
])
// Stamps name the bytes at a path; retracts mean the line no longer knows them.
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
export const SUBTREE_RETRACT_OPS: ReadonlySet<string> = new Set([
  'rm_r',
  'rename_prefix',
  'copy_prefix',
])

/**
 * A line's records indexed as they arrive, for per-path version lookups.
 * Each lookup first takes in the records appended since the last one, so a
 * record added while a caller awaits is seen, and no record is read twice.
 * The records are only ever appended to. Mirrors Python's `RecordIndex`.
 */
export class RecordIndex {
  private readonly records: readonly OpRecord[]
  private seen = 0
  private readonly at = new Map<string, number>()
  private readonly subtree: number[] = []

  constructor(records: readonly OpRecord[]) {
    this.records = records
  }

  private absorb(): void {
    for (let i = this.seen; i < this.records.length; i++) {
      const rec = this.records[i]
      if (rec === undefined) continue
      if (VERSION_OPS.has(rec.op)) this.at.set(rec.path, i)
      if (SUBTREE_RETRACT_OPS.has(rec.op)) this.subtree.push(i)
    }
    this.seen = this.records.length
  }

  /**
   * The newest record that says which version of `key` the line knows: one
   * at the path that stamps or retracts a version, or one at an ancestor
   * that moved the whole subtree, which took `key` with it. Mirrors
   * Python's `RecordIndex.newest_version`.
   */
  newestVersion(key: string): OpRecord | null {
    this.absorb()
    const at = this.at.get(key) ?? -1
    for (let j = this.subtree.length - 1; j >= 0; j--) {
      const i = this.subtree[j] ?? -1
      if (i <= at) break
      const rec = this.records[i]
      if (rec !== undefined && underPath(key, rec.path)) return rec
    }
    return at >= 0 ? (this.records[at] ?? null) : null
  }
}

export interface OpRecordInit {
  executionId?: string | null
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
}

export class OpRecord {
  readonly executionId: string | null
  readonly op: string
  readonly path: string
  readonly source: string
  bytes: number
  readonly timestamp: number
  durationMs: number
  fingerprint: string | null
  revision: string | null
  readonly mountId: string | null

  constructor(init: OpRecordInit) {
    this.executionId = init.executionId ?? null
    this.op = init.op
    this.path = init.path
    this.source = init.source
    this.bytes = init.bytes
    this.timestamp = init.timestamp
    this.durationMs = init.durationMs
    this.fingerprint = init.fingerprint ?? null
    this.revision = init.revision ?? null
    this.mountId = init.mountId ?? null
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
      ...(this.executionId === null ? {} : { execution_id: this.executionId }),
    }
  }
}
