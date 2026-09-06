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

/** One `-exec` action: the words between `-exec` and its terminator, `{}`
 * still in place, and whether it is `{} +` (one run over every match)
 * rather than `;` (one run per match). */
export interface ExecAction {
  readonly kind: 'exec'
  readonly argv: readonly string[]
  readonly batch: boolean
}

export type RowActionKind = 'print' | 'print0' | 'ls' | 'delete'

/** One of find's row actions, in the position it was written. */
export interface RowAction {
  readonly kind: RowActionKind
}

export type FindAction = ExecAction | RowAction
