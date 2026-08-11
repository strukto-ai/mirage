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

import type { Limit, MountBackend, MountMode, Resource } from '@struktoai/mirage-core'

export interface MountSpecOptions {
  /** Per-mount mode override; falls back to the workspace default when unset. */
  mode?: MountMode
  /**
   * How the mount is exposed. `vfs` (the default) keeps it inside mirage's
   * own filesystem; `fuse` and `fskit` also register a real mountpoint.
   */
  backend?: MountBackend
  /**
   * Where to mount, for the kernel backends. Omitted picks a temporary
   * directory appropriate for the backend. Ignored when backend is `vfs`.
   */
  mountpoint?: string
  commandLimits?: Record<string, Limit>
}

export class Mount {
  constructor(
    readonly resource: Resource,
    readonly options: MountSpecOptions = {},
  ) {}
}
