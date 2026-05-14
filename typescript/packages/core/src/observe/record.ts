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

import { ResourceName } from '../types.ts'

export interface OpRecordInit {
  op: string
  path: string
  source: string
  bytes: number
  timestamp: number
  durationMs: number
  /**
   * Content-derived identifier the backend returned for this read (ETag,
   * md5). Captured at read time so the snapshot reflects what the agent
   * actually saw. Null for writes, metadata ops, and backends without
   * snapshot support.
   */
  fingerprint?: string | null
  /**
   * Stable revision handle the backend returned (S3 VersionId, Drive
   * revisionId, Git SHA). Strictly stronger than fingerprint — populated
   * only by backends that can guarantee revision durability. Used by
   * replay to pin reads to the exact recorded version.
   */
  revision?: string | null
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

  constructor(init: OpRecordInit) {
    this.op = init.op
    this.path = init.path
    this.source = init.source
    this.bytes = init.bytes
    this.timestamp = init.timestamp
    this.durationMs = init.durationMs
    this.fingerprint = init.fingerprint ?? null
    this.revision = init.revision ?? null
  }

  get isCache(): boolean {
    return this.source === ResourceName.RAM
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
