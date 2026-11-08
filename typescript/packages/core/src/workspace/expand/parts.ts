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

import { callerSignal, sessionAccess } from '../../context/session_context.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { PathSpec } from '../../types.ts'
import type { EvaluationContext } from '../evaluation.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { classifyWord } from './classify/index.ts'
import { expand } from './node.ts'
import type { ExecuteFn } from './types.ts'

/**
 * Expand parsed child nodes to words that still know their quoting.
 *
 * Each node brace-expands, expands and splits on IFS, so an unquoted
 * expansion anywhere in a word splits (`q$x` too) and quoted text never
 * does. A glob character quoting made literal travels under its own mark,
 * so `"/data/"*.txt` still globs while `'/data/*'.txt` does not;
 * `unmarkGlobs` takes the marks off.
 */
export async function expandWords(
  parts: readonly TSNodeLike[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
): Promise<string[]> {
  const result: string[] = []
  // Each word expands in one step; the line yields between words, so a
  // cancel or its deadline lands before the last.
  const budget = new YieldBudget(callerSignal())
  for (const part of parts) {
    const fields = await expand(part, 'fields', context, executeFn, callStack)
    for (const field of fields as readonly string[]) result.push(field)
    await budget.run()
  }
  return result
}

/**
 * Expand words, classify as PathSpec or text. Used by for/select where
 * concrete values are needed before iteration. Words keep their glob marks,
 * because the loop list is glob-resolved next (`resolveGlobs`, which is
 * where the marks come off): `for f in '/data/*.txt'` iterates once over
 * the name as typed, like bash, while `for f in '/data/*'?.txt` still globs
 * on the `?`.
 */
export async function expandAndClassify(
  words: readonly TSNodeLike[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  cwd: string,
  callStack: CallStack | null = null,
): Promise<(string | PathSpec)[]> {
  const expanded = await expandWords(words, context, executeFn, callStack)
  // One word can expand to a million (`a=($x)`), so classifying them
  // yields too.
  const budget = new YieldBudget(callerSignal())
  const access = sessionAccess(context.session)
  const classified: (string | PathSpec)[] = []
  for (const word of expanded) {
    classified.push(classifyWord(word, registry, cwd, access))
    await budget.run()
  }
  return classified
}
