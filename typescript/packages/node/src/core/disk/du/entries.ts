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

import type { DiskAccessor } from '../../../accessor/disk.ts'
import type { PathSpec } from '@struktoai/mirage-core'
import { norm, resolveSafe } from '../utils.ts'
import { walkAll } from './walk.ts'
import { compareCodePoints } from '@struktoai/mirage-core'

export async function entries(
  accessor: DiskAccessor,
  p: PathSpec,
): Promise<[entries: [string, number][], total: number]> {
  const virtual = norm(p.mountPath)
  const full = resolveSafe(accessor.root, virtual)
  const entries: [string, number][] = []
  const total = await walkAll(accessor, full, entries)
  entries.sort((a, b) => compareCodePoints(a[0], b[0]))
  return [entries, total]
}
