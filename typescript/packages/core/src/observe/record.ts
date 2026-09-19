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
export const READ_FINGERPRINT_OPS: ReadonlySet<string> = new Set(['read'])
export const WRITE_FINGERPRINT_OPS: ReadonlySet<string> = new Set(['write'])

export interface OpRecordInit {
  op: string
  path: string
  source: string
  bytes: number
  timestamp: number
  durationMs: number
  /**
   * On a read, and on an object store's write, create and truncate, the
   * content-derived identifier the backend returned (ETag, md5).
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
    }
  }
}
