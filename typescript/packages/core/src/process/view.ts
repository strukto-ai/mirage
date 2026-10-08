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

import type { ChildProcess } from './child.ts'
import type { ProcessInfo, SpawnRequest } from './types.ts'

/**
 * Profile-scoped operations. Seeing a process grants no streams; invisible
 * PIDs return null. Stopping one the view sees but may not stop throws EPERM.
 */
export interface ProcessView {
  readonly list: () => readonly ProcessInfo[]
  readonly get: (pid: number) => ProcessInfo | null
  readonly checkSpawn: () => void
  readonly probe: (pid: number) => boolean
  readonly terminate: (pid: number) => boolean
  readonly wait: (pid: number) => Promise<ProcessInfo | null>
  readonly depth?: number
  readonly spawn?: (request: SpawnRequest) => ChildProcess
}
