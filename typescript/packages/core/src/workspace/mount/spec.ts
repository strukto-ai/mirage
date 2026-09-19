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

import type { IndexConfig } from '../../cache/index/config.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import type { Limit, MountBackend, MountMode } from '../../types.ts'

export interface MountSpecOptions {
  /** Per-mount mode override; falls back to the workspace default when unset. */
  mode?: MountMode
  /**
   * How the mount is exposed. `workspace` (the default) keeps it inside mirage's
   * own filesystem; `fuse` and `fskit` also register a real mountpoint.
   */
  backend?: MountBackend
  /**
   * Where to mount, for the kernel backends. Omitted picks a temporary
   * directory appropriate for the backend. Ignored when backend is `workspace`.
   */
  mountpoint?: string
  commandLimits?: Record<string, Limit>
  /**
   * The `vfs:` value the driver was built from: a registry name (`s3`)
   * or a code reference (`./wiki.mjs:WikiVFS`), null for one constructed
   * in code. A snapshot records it so the loader can rebuild the mount
   * through the same door.
   */
  vfsRef?: string | null
  /**
   * The index store this mount runs its driver under; omitted takes the
   * workspace's index config, or a RAM store at the driver's `indexTtl`
   * when there is none.
   */
  index?: IndexConfig
}

export class Mount {
  constructor(
    readonly vfs: BaseVFS,
    readonly options: MountSpecOptions = {},
  ) {}
}
