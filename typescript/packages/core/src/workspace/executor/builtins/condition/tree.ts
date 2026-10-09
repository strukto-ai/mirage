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

import { compilePosixRegex } from '../../../../utils/posix.ts'
import { BreError, PosixSyntax, translateEre } from '../../../../commands/builtin/utils/bre.ts'
import { randomReader, seedVar, sessionArith } from '../../../session/state.ts'
import type { ArithResult, ArithWrite } from '../../../../shell/types.ts'
import { assignElement } from '../../../session/elements.ts'
import { ArithError, ReadonlyError } from '../../../../shell/errors.ts'
import { makeArray } from '../../../../shell/array.ts'
import { fnmatch } from '../../../../utils/fnmatch.ts'
import { FILE_PAIR_BINARY, INT_COMPARATORS, UNARY_OPS } from './constants.ts'
import { applyFilePair, applyUnary } from './operators.ts'
import { CondError } from './types.ts'
import type { CondContext, CondNode } from './types.ts'

/** Evaluate a structured [[ ]] expression tree. */
export async function evalCond(ctx: CondContext, node: CondNode): Promise<boolean> {
  if (node.kind === 'and') {
    return (await evalCond(ctx, node.left)) && (await evalCond(ctx, node.right))
  }
  if (node.kind === 'or') {
    return (await evalCond(ctx, node.left)) || (await evalCond(ctx, node.right))
  }
  if (node.kind === 'not') return !(await evalCond(ctx, node.inner))
  if (node.kind === 'unary') {
    if (!UNARY_OPS.has(node.op)) {
      throw new CondError('mirage: conditional unary operator expected')
    }
    return applyUnary(ctx, node.op, node.operand)
  }
  if (node.kind === 'binary') return evalCondBinary(ctx, node)
  return node.value !== ''
}

async function evalCondBinary(
  ctx: CondContext,
  node: Extract<CondNode, { kind: 'binary' }>,
): Promise<boolean> {
  // == and != always fnmatch: the builder already rendered the right
  // side into the glob dialect, quoted segments escaped, so a
  // wholly-literal pattern matches exactly itself.
  if (node.op === '=' || node.op === '==') {
    return fnmatch(node.left, node.right)
  }
  if (node.op === '!=') {
    return !fnmatch(node.left, node.right)
  }
  if (node.op === '=~') {
    const pattern = node.rightLiteral
      ? node.right.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : node.right
    // bash hands the pattern to regcomp(REG_EXTENDED): glibc's
    // POSIX_EXTENDED syntax, where `\d` is a `d` and `(?` is refused.
    let match: RegExpExecArray | null
    try {
      match = compilePosixRegex(translateEre(pattern, PosixSyntax.EXTENDED)[0]).exec(node.left)
    } catch (err) {
      if (!(err instanceof BreError) && !(err instanceof SyntaxError)) throw err
      throw new CondError('mirage: syntax error in conditional expression')
    }
    if (match === null) return false
    seedVar(
      ctx.session,
      'BASH_REMATCH',
      makeArray([match[0], ...match.slice(1).map((g: string | undefined) => g ?? '')]),
    )
    return true
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
    // so each operand lands its assignments through the gated door before
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
      // bash: `R: readonly variable`, status 1, and the line goes on; in
      // a subscript it ends the shell.
      if (error instanceof ReadonlyError) {
        if (error.inSubscript) throw error.signal()
        throw new CondError(`bash: ${error.message}`, 1, false)
      }
      // bash: `[[: 1/0: division by 0`, status 1, and the line goes on;
      // one in a subscript discards it.
      if (error !== null) {
        if (error.inSubscript) throw error.signal()
        throw new CondError(`bash: ${ctx.name}: ${error.message}`, 1, false)
      }
      values.push(value)
    }
    return compare(values[0] ?? 0n, values[1] ?? 0n)
  }
  if (FILE_PAIR_BINARY.has(node.op)) return applyFilePair(ctx, node.op, node.left, node.right)
  throw new CondError('mirage: conditional binary operator expected')
}
