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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import { CapacityState, type CapacityResult } from '../../types.ts'
import { rootContext } from './resolve.ts'

/**
 * The account's Drive storage quota, for df. A mount rooted in a shared drive
 * is UNKNOWN: its files count against the organization's pool, which no one
 * account's quota describes. An account Drive reports no limit for has
 * unlimited storage, ELASTIC. Mirrors Python's `capacity`.
 */
export async function capacity(accessor: GDriveAccessor): Promise<CapacityResult> {
  const [, shared] = await rootContext(accessor)
  if (shared !== null && shared !== '') return { state: CapacityState.UNKNOWN }
  const quota = await accessor.drive.storageQuota()
  if (quota.limit === undefined) return { state: CapacityState.ELASTIC }
  const total = Number(quota.limit)
  const used = Number(quota.usage ?? 0)
  return {
    state: CapacityState.QUOTA,
    total,
    used,
    available: Math.max(total - used, 0),
  }
}
