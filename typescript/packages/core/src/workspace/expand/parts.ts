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

import type { CallStack } from '../../shell/call_stack.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { PathSpec } from '../../types.ts'
import { expandTilde } from '../../utils/path.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { Session } from '../session/session.ts'
import { homeDir } from '../session/shell_dirs.ts'
import { expandTemplate, makeInert, substitute } from './brace.ts'
import { classifyWord } from './classify/index.ts'
import { BRACE_LITERAL_TYPES, BRACE_WORD_TYPES, SPLIT_TYPES } from './constants.ts'
import { expandNode, unescapeUnquoted, type ExecuteFn } from './node.ts'
import { expandArrayAt, isMultiwordAt, type TSNodeLike } from './variable.ts'

// Brace-expand a concatenation or brace_expression into words. Literal
// word tokens form the brace template; every other child (expansions,
// strings, substitutions) expands first and joins as an inert atom, so
// `{a,$v}` alternates on the expanded value while `{1..$n}` stays
// literal, matching bash's brace-before-parameter ordering. Deliberate
// divergence: bash rewrites `$v{a,b}` to `$va $vb` before parameter
// expansion; here the prefix keeps its own expansion (`prea preb`),
// which is the useful reading.
async function expandBraceWord(
  node: TSNodeLike,
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<string[] | null> {
  const pieces: string[] = []
  const values: string[] = []
  for (const child of node.children) {
    if (child.isNamed !== true || BRACE_LITERAL_TYPES.has(child.type)) {
      pieces.push(child.text)
    } else {
      values.push(await expandNode(child, session, executeFn, callStack))
      pieces.push(makeInert(values.length - 1))
    }
  }
  const words = expandTemplate(pieces.join(''))
  if (words === null) return null
  const home = homeDir(session)
  return words.map((w) => substitute(expandTilde(unescapeUnquoted(w), home), values))
}

function hasAtExpansion(node: TSNodeLike): boolean {
  for (const child of node.children) {
    if (child.type === NT.SIMPLE_EXPANSION && child.text === '$@') return true
  }
  return false
}

function getPositionalArgs(session: Session, callStack: CallStack | null): string[] {
  if (callStack && callStack.getAllPositional().length > 0) {
    return callStack.getAllPositional()
  }
  return session.positionalArgs
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
): Promise<string[]> {
  const expandChild = (n: TSNodeLike) => expandNode(n, session, executeFn, callStack)
  const fragments: string[] = ['']
  for (const child of node.children) {
    if (child.type === NT.DQUOTE) continue
    if (isMultiwordAt(child)) {
      const words = await expandArrayAt(child, session, callStack, expandChild)
      if (words.length === 0) continue
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
    const text = await expandNode(child, session, executeFn, callStack)
    const last = fragments.length - 1
    fragments[last] = (fragments[last] ?? '') + text
  }
  return fragments
}

export async function expandParts(
  parts: TSNodeLike[],
  session: Session,
  executeFn: ExecuteFn,
  callStack: CallStack | null = null,
): Promise<string[]> {
  const result: string[] = []
  for (const p of parts) {
    if (p.type === NT.STRING && hasAtExpansion(p)) {
      const positional = getPositionalArgs(session, callStack)
      if (positional.length > 0) {
        result.push(...positional)
        continue
      }
    }
    if (p.type === NT.STRING && stringHasArrayAt(p)) {
      const words = await expandStringWithArray(p, session, executeFn, callStack)
      result.push(...words)
      continue
    }
    if (BRACE_WORD_TYPES.has(p.type)) {
      const braceWords = await expandBraceWord(p, session, executeFn, callStack)
      if (braceWords !== null) {
        // Empty unquoted words vanish, like bash: {,x} -> x.
        for (const w of braceWords) {
          if (w !== '') result.push(w)
        }
        continue
      }
    }
    const expanded = await expandNode(p, session, executeFn, callStack)
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
      // A quoted word stays a word even when it expands to "" (echo ""
      // or "$EMPTY"), except "$@"/"${a[@]}" which yield zero words.
      if (expanded !== '' || !hasAtExpansion(p)) result.push(expanded)
    } else if (p.type === NT.RAW_STRING) {
      result.push(expanded)
    } else if (expanded !== '') {
      result.push(expanded)
    }
  }
  return result
}

export async function expandAndClassify(
  words: TSNodeLike[],
  session: Session,
  executeFn: ExecuteFn,
  registry: MountRegistry,
  cwd: string,
  callStack: CallStack | null = null,
): Promise<(string | PathSpec)[]> {
  const expanded = await expandParts(words, session, executeFn, callStack)
  return expanded.map((w) => classifyWord(w, registry, cwd))
}
