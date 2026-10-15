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
import { CapacityState, type CapacityResult } from '../../types.ts'
import { graphGet } from '../msgraph/client.ts'
import { driveBase } from './client.ts'

/**
 * The drive's storage quota, for df: Graph's `quota` facet, its `remaining`
 * the space left. A drive without one is UNKNOWN. Mirrors Python's
 * `capacity`.
 */
export async function capacity(accessor: OneDriveAccessor): Promise<CapacityResult> {
  const drive = await graphGet(accessor.config, driveBase(accessor.config), { $select: 'quota' })
  const quota = (drive.quota ?? {}) as { total?: number; used?: number; remaining?: number }
  if (quota.total === undefined) return { state: CapacityState.UNKNOWN }
  const total = quota.total
  const used = quota.used ?? 0
  return {
    state: CapacityState.QUOTA,
    total,
    used,
    available: quota.remaining ?? Math.max(total - used, 0),
  }
}
