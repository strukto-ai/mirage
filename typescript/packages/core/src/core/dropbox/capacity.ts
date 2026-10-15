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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { CapacityState, type CapacityResult } from '../../types.ts'
import { dropboxRpc } from './client.ts'

/**
 * The account's Dropbox space, for df. An individual account's allocation is
 * its own. On a team, a limit set for this member bounds what it may use;
 * without one the team's shared allocation does. Mirrors Python's
 * `capacity`.
 */
export async function capacity(accessor: DropboxAccessor): Promise<CapacityResult> {
  const usage = (await dropboxRpc(accessor.tokenManager, '/users/get_space_usage', null)) as {
    used?: number
    allocation?: {
      '.tag'?: string
      allocated?: number
      used?: number
      user_within_team_space_allocated?: number
    }
  }
  const allocation = usage.allocation ?? {}
  let used = usage.used ?? 0
  let total: number
  if (allocation['.tag'] === 'individual') {
    total = allocation.allocated ?? 0
  } else if (allocation['.tag'] === 'team') {
    total = allocation.user_within_team_space_allocated ?? 0
    if (total === 0) {
      total = allocation.allocated ?? 0
      used = allocation.used ?? 0
    }
  } else {
    return { state: CapacityState.UNKNOWN }
  }
  if (total === 0) return { state: CapacityState.UNKNOWN }
  return { state: CapacityState.QUOTA, total, used, available: Math.max(total - used, 0) }
}
