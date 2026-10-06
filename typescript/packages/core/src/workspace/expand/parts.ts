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

import type { EvaluationContext } from '../evaluation.ts'
import type { SessionView } from '../../ops/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import type { PathSpec } from '../../types.ts'
import { markEscapedGlobs } from '../../utils/glob_walk.ts'
import { expandTilde } from '../../utils/path.ts'
import type { MountRegistry } from '../mount/registry.ts'

import { homeDir } from '../session/shell_dirs.ts'
import { expandTemplate, makeInert, substitute } from './brace.ts'
import { classifyWord } from './classify/index.ts'
import { BRACE_LITERAL_TYPES, BRACE_WORD_TYPES } from './constants.ts'
import { splitFields } from './fields.ts'
import { expandChunks, type ExecuteFn } from './node.ts'
import type { Chunk } from './types.ts'
import { ifsValue } from './variable.ts'
import { unescapeUnquoted } from '../../shell/escapes.ts'
import type { TSNodeLike } from '../../shell/types.ts'

// Brace-expand a concatenation or brace_expression into words. Literal
// word tokens form the brace template; every other child (expansions,
// strings, substitutions) expands first and joins as an inert atom, so
// `{a,$v}` alternates on the expanded value while `{1..$n}` stays
// literal, matching bash's brace-before-parameter ordering. Deliberate
// divergence: bash rewrites `$v{a,b}` to `$va $vb` before parameter
// expansion; here the prefix keeps its own expansion (`prea preb`),
// which is the useful reading.
//
// Quoting rides along per character: an atom keeps whatever marks its
// own expansion produced, and the template's escapes are marked before
// quote removal drops them, so `{'*',x}` stays literal while `{$p,x}`
// keeps the value live. Each word keeps its atoms' pieces, so an
// unquoted value still splits: `{a,b}$x` is `a$x b$x`.
async function expandBraceWord(
  node: TSNodeLike,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<Chunk[][] | null> {
  const session = context.session
  const pieces: string[] = []
  const atoms: TSNodeLike[] = []
  for (const child of node.children) {
    if (child.isNamed !== true || BRACE_LITERAL_TYPES.has(child.type)) {
      pieces.push(child.text)
    } else {
      atoms.push(child)
      pieces.push(makeInert(atoms.length - 1))
    }
  }
  const words = expandTemplate(pieces.join(''))
  if (words === null) return null
  const values: Chunk[][] = []
  for (const atom of atoms) {
    values.push(await expandChunks(atom, context, executeFn, callStack, view))
  }
  const home = homeDir(session)
  return words.map((w) =>
    substitute(expandTilde(unescapeUnquoted(markEscapedGlobs(w)), home), values),
  )
}

/**
 * Expand tree-sitter child nodes to words that still know their quoting.
 *
 * Each node expands to its pieces, which IFS then splits into fields, so
 * an unquoted expansion anywhere in a word splits (`q$x` too) and quoted
 * text never does. A glob character quoting made literal travels under its
 * own mark, so `"/data/"*.txt` still globs while `'/data/*'.txt` does not
 * and `'/data/*'?.txt` globs on the `?` alone; `unmarkGlobs` takes the
 * marks off.
 */
export async function expandWords(
  parts: TSNodeLike[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  view?: SessionView,
): Promise<string[]> {
  const session = context.session
  const ifs = ifsValue(session, callStack)
  const result: string[] = []
  for (const p of parts) {
    if (BRACE_WORD_TYPES.has(p.type) && session.shellOptions.braceexpand !== false) {
      const braceWords = await expandBraceWord(p, context, executeFn, callStack, view)
      if (braceWords !== null) {
        for (const chunks of braceWords) for (const w of splitFields(chunks, ifs)) result.push(w)
        continue
      }
    }
    const chunks = await expandChunks(p, context, executeFn, callStack, view)
    for (const w of splitFields(chunks, ifs)) result.push(w)
  }
  return result
}

export async function expandAndClassify(
  words: TSNodeLike[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  cwd: string,
  callStack: CallStack | null = null,
  view?: SessionView,
): Promise<(string | PathSpec)[]> {
  // Words keep their glob marks, because the loop list is glob-resolved
  // next (`resolveGlobs`, which is where the marks come off): `for f in
  // '/data/*.txt'` iterates once over the name as typed, like bash,
  // while `for f in '/data/*'?.txt` still globs on the `?`.
  const expanded = await expandWords(words, context, executeFn, callStack, view)
  return expanded.map((w) => classifyWord(w, registry, cwd))
}
