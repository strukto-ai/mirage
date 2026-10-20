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

import { describe, expect, it } from 'vitest'

import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { evalFlat } from './flat.ts'
import { CondError, type CondContext } from './types.ts'

// Mirrors python/tests/workspace/executor/builtins/condition/test_flat.py.

function ctx(): CondContext {
  return {
    dispatch: (() => Promise.reject(new Error('no dispatch'))) as unknown as DispatchFn,
    namespace: {} as Namespace,
    session: { cwd: '/data' } as unknown as SessionState,
    name: 'test',
  }
}

/** `n` terms joined by `-a`, every one `x` but the last. */
function chain(n: number, last: string): string[] {
  return ['x', ...Array.from({ length: n - 2 }, () => ['-a', 'x']).flat(), '-a', last]
}

describe('evalFlat', () => {
  it('reads a long chain in a loop', async () => {
    // test reads -a and -o chains in a loop, so a chain's length costs no
    // stack: 3000 terms read and evaluate as 3 do.
    expect(await evalFlat(ctx(), chain(3000, 'x'))).toBe(true)
    expect(
      await evalFlat(ctx(), ['x', ...Array.from({ length: 2999 }, () => ['-o', '']).flat()]),
    ).toBe(true)
    expect(await evalFlat(ctx(), chain(3000, ''))).toBe(false)
  })

  it('reaches a term before a grammar error after it', async () => {
    const run = evalFlat(ctx(), ['1', '-eq', 'x', '-a'])
    await expect(run).rejects.toBeInstanceOf(CondError)
    await expect(run).rejects.toThrow('x: integer expression expected')
  })
})
