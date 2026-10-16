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

import type { OneDriveAccessor } from '../../accessor/onedrive.ts'
import type { PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { DeltaHook } from '../../events/base.ts'
import { GraphDeltaHook, type DeltaTarget } from '../msgraph/events.ts'
import { driveBase } from './client.ts'

/**
 * Build the OneDrive delta hook: the drive's `/delta` feed (`GraphDeltaHook`),
 * placed under the mount's `keyPrefix`. Mirrors Python `build_delta_hook`.
 */
export function buildDeltaHook(accessor: OneDriveAccessor): DeltaHook {
  const config = accessor.config
  const targets = (root: PathSpec): Promise<DeltaTarget[]> => {
    const prefix = rstripSlash(mountPrefixOf(root.virtual, root.vfsPath))
    return Promise.resolve([
      { drive: driveBase(config), folder: config.keyPrefix, virtual: prefix === '' ? '/' : prefix },
    ])
  }
  return new GraphDeltaHook(config, targets)
}
