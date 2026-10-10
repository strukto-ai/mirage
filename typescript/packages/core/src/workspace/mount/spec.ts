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

import type { IndexConfig, RedisIndexConfig } from '../../cache/index/config.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import type { Limit, MountBackend, MountMode, ReadSpec, WritePolicy } from '../../types.ts'

/** Placement settings; index, read and write fall back to the workspace defaults. */
export interface MountSpecOptions {
  mode?: MountMode
  backend?: MountBackend
  mountpoint?: string
  commandLimits?: Record<string, Limit>
  /** Registry name or code loader used to rebuild the driver from a snapshot. */
  vfsRef?: string | null
  index?: IndexConfig | RedisIndexConfig
  read?: ReadSpec
  /** Whether this mount's writes carry the version they were based on. */
  write?: WritePolicy
}

export class Mount {
  constructor(
    readonly vfs: BaseVFS,
    readonly options: MountSpecOptions = {},
  ) {}
}
