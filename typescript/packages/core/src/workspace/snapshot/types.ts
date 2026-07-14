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

import type { EventDict } from '../../observe/observer.ts'
import type { RAMResourceState } from '../../resource/ram/ram.ts'

interface ResourceStateBase {
  type: string
  config?: unknown
}

export type ResourceState = RAMResourceState | (ResourceStateBase & Record<string, unknown>)

export interface MountSnapshot {
  index: number
  prefix: string
  mode: string
  consistency: string
  resource_class: string
  resource_state: ResourceState
}

export interface CacheEntrySnapshot {
  key: string
  data: Uint8Array
  fingerprint: string | null
  ttl: number | null
  cached_at: number
  size: number
}

interface CacheSnapshot {
  limit: number
  max_drain_bytes: number | null
  entries: CacheEntrySnapshot[]
}

interface ExecutionNodeSnapshot {
  command: string | null
  op: string | null
  stderr: Uint8Array
  exit_code: number
  children: ExecutionNodeSnapshot[]
}

export interface ExecutionRecordSnapshot {
  agent: string
  command: string
  stdout: Uint8Array
  stdin: Uint8Array | null
  exit_code: number
  tree: ExecutionNodeSnapshot
  timestamp: number
  session_id: string
}

export interface SessionSnapshot {
  session_id: string
  cwd: string
  env: Record<string, string>
}

export interface JobSnapshot {
  id: number
  command: string
  cwd: string
  status: string
  stdout: Uint8Array
  stderr: Uint8Array
  exit_code: number
  created_at: number
  agent: string
  session_id: string
}

/**
 * One snapshot-time fingerprint entry per recorded read on a
 * snapshot-capable mount. Carries the backend's identifier(s) for the
 * bytes the agent actually saw, populated at read time from the GET
 * response. At least one of `fingerprint` and `revision` is non-null.
 */
export interface NodeMetaSnapshot {
  target?: string
  mtime?: number
  mode?: number
  uid?: number | string
  gid?: number | string
  atime?: string
}

export interface FingerprintEntrySnapshot {
  path: string
  mount_prefix: string
  fingerprint?: string | null
  revision?: string | null
}

export interface WorkspaceStateDict {
  version: number
  mirage_version: string
  default_session_id: string
  default_agent_id: string
  current_agent_id: string
  sessions: SessionSnapshot[]
  mounts: MountSnapshot[]
  cache: CacheSnapshot
  history: EventDict[]
  jobs: JobSnapshot[]
  /**
   * Per-path fingerprint/revision pairs captured at snapshot time.
   * Optional for backwards compatibility with v1 snapshots that
   * predate drift detection.
   */
  fingerprints?: FingerprintEntrySnapshot[]
  /**
   * Mount prefixes whose resource opts out of snapshot replay
   * (e.g. Gmail, Slack). Replay logs a warning naming these.
   */
  live_only_mounts?: string[]
  /**
   * Namespace node table: path -> per-path metadata (symlink target and
   * attribute overlay). Only non-null fields are serialized. Optional for
   * backwards compatibility with snapshots that predate the table.
   */
  nodes?: Record<string, NodeMetaSnapshot>
}
