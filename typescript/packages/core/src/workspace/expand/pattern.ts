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

import type { Policies } from '../../policy/index.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { escapeGlob } from '../../utils/glob_walk.ts'
import type { EvaluationContext } from '../evaluation.ts'
import { expand } from './node.ts'
import type { ExecuteFn } from './types.ts'

/**
 * Expand one pattern word into the matcher's glob dialect, as case patterns
 * and the right side of `[[ == ]]` read it: quoted text matches only itself.
 */
export async function expandPattern(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  policies: Policies | null = null,
): Promise<string> {
  const runs = await expand(tsNode, 'pattern', context, executeFn, callStack, policies)
  return (runs as readonly (readonly [string, boolean])[])
    .map(([text, quoted]) => (quoted ? escapeGlob(text) : text))
    .join('')
}

/**
 * Expand the right side of `[[ =~ ]]` into a POSIX extended regex: quoted
 * text matches only itself.
 */
export async function expandRegex(
  tsNode: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  policies: Policies | null = null,
): Promise<string> {
  return (await expand(tsNode, 'regex', context, executeFn, callStack, policies)) as string
}
