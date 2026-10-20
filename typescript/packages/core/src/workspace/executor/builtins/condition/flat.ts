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

import { type PathSpec, wordText } from '../../../../types.ts'
import { scopePath } from '../scope.ts'
import { applyBinary, applyUnary } from './operators.ts'
import { flatShape } from './shape.ts'
import { CondError } from './types.ts'
import type { CondContext, FlatNode } from './types.ts'

/** Evaluate a flat test/[ argument list by test's own reading of it (`flatShape`). */
export async function evalFlat(ctx: CondContext, argv: (string | PathSpec)[]): Promise<boolean> {
  const shape = flatShape(
    ctx.name,
    argv.map((a) => wordText(a)),
  )
  return value(ctx, shape, argv)
}

function at(argv: (string | PathSpec)[], i: number): string | PathSpec {
  const v = argv[i]
  if (v === undefined) throw new CondError('argument expected')
  return v
}

/** Evaluate one node of a reading over the words it names by place. */
async function value(
  ctx: CondContext,
  node: FlatNode,
  argv: (string | PathSpec)[],
): Promise<boolean> {
  if (node === null) return false
  switch (node.kind) {
    case 'string':
      return scopePath(at(argv, node.at)) !== ''
    case 'unary':
      return applyUnary(ctx, node.op, at(argv, node.at))
    case 'binary':
      return applyBinary(ctx, at(argv, node.left), node.op, at(argv, node.right))
    case 'not':
      return !(await value(ctx, node.inner, argv))
    case 'fail':
      throw new CondError(node.message)
    case 'and':
    case 'or': {
      // test evaluates every term of -a and -o as it reads them, a chain in
      // one loop as test's own parser reads it.
      const values: boolean[] = []
      for (const term of node.terms) values.push(await value(ctx, term, argv))
      return node.kind === 'and' ? values.every(Boolean) : values.some(Boolean)
    }
  }
}
