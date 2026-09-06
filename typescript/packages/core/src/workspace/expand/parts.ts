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

import type { SessionView } from '../../ops/types.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { PathSpec } from '../../types.ts'
import { markEscapedGlobs, markGlobs, unmarkGlobs } from '../../utils/glob_walk.ts'
import { expandTilde } from '../../utils/path.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { expandTemplate, makeInert, substitute } from './brace.ts'
import { classifyWord } from './classify/index.ts'
import { BRACE_LITERAL_TYPES, BRACE_WORD_TYPES, SPLIT_TYPES } from './constants.ts'
import { expandNode, expandNodeMarked, foldedWhitespace, type ExecuteFn } from './node.ts'
import { expandArrayAt, isMultiwordAt } from './variable.ts'
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
// keeps the value live.
async function expandBraceWord(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<string[] | null> {
  const pieces: string[] = []
  const values: string[] = []
  for (const child of node.children) {
    if (child.isNamed !== true || BRACE_LITERAL_TYPES.has(child.type)) {
      pieces.push(child.text)
    } else {
      values.push(await expandNodeMarked(child, session, executeFn, callStack, view))
      pieces.push(makeInert(values.length - 1))
    }
  }
  const words = expandTemplate(pieces.join(''))
  if (words === null) return null
  const home = homeDir(session)
  return words.map((w) =>
    substitute(expandTilde(unescapeUnquoted(markEscapedGlobs(w)), home), values),
  )
}

function stringHasArrayAt(node: TSNodeLike): boolean {
  for (const c of node.children) {
    if (isMultiwordAt(c)) return true
  }
  return false
}

async function expandStringWithArray(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  view?: SessionView,
): Promise<string[]> {
  const expandChild = (n: TSNodeLike) => expandNode(n, session, executeFn, callStack, view)
  const fragments: string[] = ['']
  let splatYielded = false
  for (const child of node.children) {
    if (child.type === NT.DQUOTE) continue
    if (isMultiwordAt(child)) {
      const words = await expandArrayAt(child, session, callStack, expandChild, view)
      // The separating whitespace is folded into this node, and survives
      // even when the array is empty: bash renders "$x ${empty[@]}" as
      // the single word "a ".
      const gap = fragments.length - 1
      fragments[gap] = (fragments[gap] ?? '') + foldedWhitespace(child)
      if (words.length === 0) continue
      splatYielded = true
      const last = fragments.length - 1
      if (words.length === 1) {
        fragments[last] = (fragments[last] ?? '') + (words[0] ?? '')
      } else {
        fragments[last] = (fragments[last] ?? '') + (words[0] ?? '')
        for (let i = 1; i < words.length - 1; i++) fragments.push(words[i] ?? '')
        fragments.push(words[words.length - 1] ?? '')
      }
      continue
    }
    const text = await expandNode(child, session, executeFn, callStack, view)
    const last = fragments.length - 1
    fragments[last] = (fragments[last] ?? '') + text
  }
  // A splat that yielded nothing, with no text around it, is no word at
  // all. One empty ELEMENT is a word though (set -- "" passes one empty
  // argument), so the rendered text cannot decide this; only the element
  // count can. An empty expansion beside it does not rescue the word
  // either: with no parameters, "$u$@" is nothing.
  if (!splatYielded && fragments.length === 1 && fragments[0] === '') return []
  // Every fragment came from inside the quotes, so its glob characters
  // are literal.
  return fragments.map((f) => markGlobs(f))
}

/**
 * Expand tree-sitter child nodes to words that still know their quoting.
 *
 * The words are exactly expandParts', except that a glob character
 * quoting made literal travels under its own mark, so
 * `"/data/"*.txt` still globs while `'/data/*'.txt` does not and
 * `'/data/*'?.txt` globs on the `?` alone. Only pathname expansion reads
 * these; everything else takes the unmarked `expandParts`.
 */
export async function expandWords(
  parts: TSNodeLike[],
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
  view?: SessionView,
): Promise<string[]> {
  const result: string[] = []
  for (const p of parts) {
    if (p.type === NT.STRING && stringHasArrayAt(p)) {
      const words = await expandStringWithArray(p, session, executeFn, callStack, view)
      result.push(...words)
      continue
    }
    if (BRACE_WORD_TYPES.has(p.type) && session.shellOptions.braceexpand !== false) {
      const braceWords = await expandBraceWord(p, session, executeFn, callStack, view)
      if (braceWords !== null) {
        // Empty unquoted words vanish, like bash: {,x} -> x.
        for (const w of braceWords) {
          if (w !== '') result.push(w)
        }
        continue
      }
    }
    const expanded = await expandNodeMarked(p, session, executeFn, callStack, view)
    if (p.type === NT.COMMAND_SUBSTITUTION) {
      for (const word of expanded.split(/\s+/)) {
        if (word !== '') result.push(word)
      }
      continue
    }
    if (SPLIT_TYPES.has(p.type)) {
      for (const word of expanded.split(/\s+/)) {
        if (word !== '') result.push(word)
      }
    } else if (p.type === NT.STRING) {
      // A quoted word stays a word even when it expands to '' (echo ""
      // or "$EMPTY"). The splats that yield zero words instead ("$@",
      // "${a[@]}") never reach here; they took the branch above.
      result.push(expanded)
    } else if (
      p.type === NT.RAW_STRING ||
      p.type === NT.ANSI_C_STRING ||
      p.type === NT.TRANSLATED_STRING
    ) {
      result.push(expanded)
    } else if (expanded !== '') {
      result.push(expanded)
    }
  }
  return result
}

export async function expandParts(
  parts: TSNodeLike[],
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
): Promise<string[]> {
  const words = await expandWords(parts, session, executeFn, callStack)
  return words.map((w) => unmarkGlobs(w))
}

export async function expandAndClassify(
  words: TSNodeLike[],
  session: Session,
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
  const expanded = await expandWords(words, session, executeFn, callStack, view)
  return expanded.map((w) => classifyWord(w, registry, cwd))
}
