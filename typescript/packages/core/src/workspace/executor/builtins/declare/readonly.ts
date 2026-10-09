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

import { VarAttr } from '../../../../shell/variable.ts'
import type { SessionState } from '../../../session/session.ts'
import type { SessionView } from '../../../../view/types.ts'
import { markNames } from './declare.ts'
import type { DeclarationOperand } from './types.ts'
import type { Result } from '../types.ts'
import type { ParseScope } from '../../../../shell/parse/scope.ts'

/**
 * Mark names readonly, or print them (`readonly -p` / bare `readonly`).
 * `-f` freezes functions: a frozen one refuses redefinition and `unset -f`
 * with its own message, exit 1, and the old body stays. With no names, `-f`
 * lists the frozen functions, each body followed by its `declare -fr NAME`
 * line (`markNames`).
 */
export async function handleReadonly(
  assignments: readonly DeclarationOperand[],
  session: SessionState,
  state: SessionView | null = null,
  parser?: ParseScope,
): Promise<Result> {
  return markNames(assignments, session, state, VarAttr.Readonly, parser)
}
