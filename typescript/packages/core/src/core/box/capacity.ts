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

import type { BoxAccessor } from '../../accessor/box.ts'
import { CapacityState, type CapacityResult } from '../../types.ts'
import { boxGet } from './client.ts'
import { UNLIMITED_SPACE } from './constants.ts'

/**
 * The account's Box storage, for df. An unlimited account reports a
 * placeholder amount, ELASTIC; one with no amount is UNKNOWN. Mirrors
 * Python's `capacity`.
 */
export async function capacity(accessor: BoxAccessor): Promise<CapacityResult> {
  const tm = accessor.tokenManager
  const me = (await boxGet(tm, `${tm.apiBase}/users/me`, {
    fields: 'space_amount,space_used',
  })) as { space_amount?: number; space_used?: number }
  if (me.space_amount === undefined) return { state: CapacityState.UNKNOWN }
  const total = me.space_amount
  if (total >= UNLIMITED_SPACE) return { state: CapacityState.ELASTIC }
  const used = me.space_used ?? 0
  return { state: CapacityState.QUOTA, total, used, available: Math.max(total - used, 0) }
}
