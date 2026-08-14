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

/**
 * One stored record's fields: the JSON-able payload a keyed-record store
 * persists. Sessions, the namespace node table and workspace metadata all
 * store this shape; the name each of them uses at its own seam is an alias.
 */
export type RecordFields = Record<string, unknown>

/**
 * Shared cap for every generation-CAS retry loop (session flush, workspace
 * meta): losing this many times in a row on a rarely written record is a bug
 * to surface, not contention to absorb.
 */
export const CAS_MAX_RETRIES = 3

/**
 * A stored record's CAS generation; a missing record or a legacy record
 * without the field counts as 0.
 */
export function generationOf(fields: Record<string, unknown> | null | undefined): number {
  if (fields === null || fields === undefined) return 0
  const generation = fields.generation
  return typeof generation === 'number' ? generation : Number(generation ?? 0)
}
