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

import { RegexError } from '../../../../rs/errors.ts'
import { posixRegex } from '../../../../rs/regex.ts'
import { randomReader, seedVar, sessionArith, visibleEnv } from '../../../session/state.ts'
import { byteView, textView, utf8Locale } from '../../../../shell/bytes.ts'
import type { ArithResult, ArithWrite } from '../../../../shell/types.ts'
import { assignElement } from '../../../session/elements.ts'
import { ArithError, ReadonlyError } from '../../../../shell/errors.ts'
import { makeArray } from '../../../../shell/array.ts'
import { fnmatch } from '../../../../utils/fnmatch.ts'
import { FILE_PAIR_BINARY, INT_COMPARATORS, UNARY_OPS } from './constants.ts'
import { applyFilePair, applyUnary } from './operators.ts'
import { runWithAdmission } from '../../../../context/session_context.ts'
import { CondError } from './types.ts'
import type { CondContext, CondNode } from './types.ts'

/**
 * Evaluate a structured [[ ]] expression tree to its status.
 *
 * A test answers 0 or 1, and a regex that does not compile answers 2
 * without a word. The expression answers what its last test did: `&&`
 * stops at the first failure, `||` at the first success, and `!` turns
 * any failure into 0.
 */
export async function evalCond(ctx: CondContext, node: CondNode): Promise<number> {
  if (node.kind === 'lazy') return evalCond(ctx, await node.expand())
  if (node.kind === 'and') {
    const left = await evalCond(ctx, node.left)
    return left !== 0 ? left : evalCond(ctx, node.right)
  }
  if (node.kind === 'or') {
    const left = await evalCond(ctx, node.left)
    return left === 0 ? 0 : evalCond(ctx, node.right)
  }
  if (node.kind === 'not') return (await evalCond(ctx, node.inner)) !== 0 ? 0 : 1
  if (ctx.admit === undefined) return evalLeaf(ctx, node)
  // A leaf is a test of its own, admitted on its words once they are
  // expanded, which for a branch is only as it is reached.
  const gate = await ctx.admit(leafWords(node))
  return runWithAdmission(gate, () => evalLeaf(ctx, node))
}

/** A `[[ ]]` leaf as the words `test` would be given for it. */
function leafWords(node: Extract<CondNode, { kind: 'word' | 'unary' | 'binary' }>): string[] {
  if (node.kind === 'unary') return [node.op, node.operand]
  if (node.kind === 'binary') return [node.left, node.op, node.right]
  return [node.value]
}

/** Evaluate one test of a `[[ ]]` expression to its status. */
async function evalLeaf(
  ctx: CondContext,
  node: Extract<CondNode, { kind: 'word' | 'unary' | 'binary' }>,
): Promise<number> {
  if (node.kind === 'unary') {
    if (!UNARY_OPS.has(node.op)) {
      throw new CondError('mirage: conditional unary operator expected')
    }
    return (await applyUnary(ctx, node.op, node.operand)) ? 0 : 1
  }
  if (node.kind === 'binary') {
    if (node.op === '=~') return await regexStatus(ctx, node)
    return (await evalCondBinary(ctx, node)) ? 0 : 1
  }
  return node.value !== '' ? 0 : 1
}

/** Match [[ left =~ right ]], filling BASH_REMATCH on a match. */
async function regexStatus(
  ctx: CondContext,
  node: Extract<CondNode, { kind: 'binary' }>,
): Promise<number> {
  // The shell's own locale, which an unexported LC_ALL sets as well.
  const utf8 = utf8Locale(visibleEnv(ctx.session))
  const left = byteView(node.left, utf8)
  // bash hands the pattern to regcomp(REG_EXTENDED): glibc's
  // POSIX_EXTENDED syntax, where `\d` is a `d` and `(?` is refused.
  let found
  try {
    found = await posixRegex(byteView(node.right, utf8), true, 'posix', false, utf8).search(
      left,
      0,
      ctx.signal,
    )
  } catch (err) {
    if (!(err instanceof RegexError)) throw err
    return 2
  }
  if (found === null) return 1
  seedVar(
    ctx.session,
    'BASH_REMATCH',
    makeArray(
      found.map((span) => (span === null ? '' : textView(left.slice(span[0], span[1]), utf8))),
    ),
  )
  return 0
}

async function evalCondBinary(
  ctx: CondContext,
  node: Extract<CondNode, { kind: 'binary' }>,
): Promise<boolean> {
  // == and != always fnmatch: the builder already rendered the right
  // side into the glob dialect, quoted segments escaped, so a
  // wholly-literal pattern matches exactly itself.
  if (node.op === '=' || node.op === '==') {
    return fnmatch(node.left, node.right, true)
  }
  if (node.op === '!=') {
    return !fnmatch(node.left, node.right, true)
  }
  if (node.op === '<') return node.left < node.right
  if (node.op === '>') return node.left > node.right
  const compare = INT_COMPARATORS.get(node.op)
  if (compare !== undefined) {
    // [[ evaluates numeric operands as arithmetic: variables resolve,
    // expressions compute, bare unset words are 0. The visible env,
    // so a hidden name reads as unset here too.
    // bash evaluates the left operand, binds what it assigned, then
    // evaluates the right (`[[ x=5 -eq x ]]` is true and leaves x at 5),
    // so each operand lands its assignments through the gated session view before
    // the next reads, RANDOM's seed included (`[[ RANDOM=42 -eq RANDOM ]]`
    // seeds, then draws).
    const reader = randomReader(ctx.session)
    const values: bigint[] = []
    for (const operand of [node.left, node.right]) {
      let error: ArithError | ReadonlyError | null = null
      let value = 0n
      let writes: readonly ArithWrite[]
      try {
        const result: ArithResult = sessionArith(ctx.session, operand, reader)
        writes = result.writes
        value = result.value
      } catch (exc) {
        if (!(exc instanceof ArithError || exc instanceof ReadonlyError)) throw exc
        // bash bound what the operand assigned before it failed
        // (`y='x=6,1/0'; [[ 0 -eq y ]]` leaves x at 6, and a RANDOM seed
        // in it is drawn from); they land, and the reader settles, before
        // the error reports.
        error = exc
        writes = exc.writes
      }
      try {
        for (const write of writes) {
          const status = await assignElement(
            ctx.session,
            ctx.view ?? null,
            write.name,
            write.key,
            write.value,
          )
          if (status !== 'ok') throw new CondError(`${ctx.name}: ${write.name}: ${status}`)
        }
      } finally {
        reader.settle()
      }
      // bash: `[[: 1/0: division by 0` or `R: readonly variable`, status 1,
      // and the line goes on; in a subscript it ends the shell.
      if (error !== null) {
        if (error.inSubscript) throw error.signal()
        const lead = error instanceof ArithError ? `${ctx.name}: ` : ''
        throw new CondError(`bash: ${lead}${error.message}`, 1, false)
      }
      values.push(value)
    }
    return compare(values[0] ?? 0n, values[1] ?? 0n)
  }
  if (FILE_PAIR_BINARY.has(node.op)) return applyFilePair(ctx, node.op, node.left, node.right)
  throw new CondError('mirage: conditional binary operator expected')
}
