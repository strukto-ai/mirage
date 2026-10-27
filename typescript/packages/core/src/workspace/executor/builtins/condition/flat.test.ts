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

import { eacces, fsError } from '../../../../errors/fs.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { PathSpec } from '../../../../types.ts'
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

/** A context whose every stat fails as `fail` builds it. */
function failingStat(fail: (path: PathSpec) => Error): CondContext {
  return {
    dispatch: ((op: string, path: PathSpec) =>
      op === 'stat'
        ? Promise.reject(fail(path))
        : Promise.reject(new Error(`unexpected ${op}`))) as unknown as DispatchFn,
    namespace: { sessionLinks: () => ({ follow: (v: string) => v }) } as unknown as Namespace,
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

  // Mirrors python's test_a_refused_stat_reads_as_absent.
  it.each([
    [['-e', '/data/b'], false],
    [['-f', '/data/b'], false],
    [['-r', '/data/b'], false],
    [['-s', '/data/b'], false],
    [['!', '-e', '/data/b'], true],
    [['/data/a', '-nt', '/data/b'], false],
  ] as const)('reads a refused stat as absent: %j', async (expr, expected) => {
    expect(await evalFlat(failingStat(eacces), [...expr])).toBe(expected)
  })

  // Mirrors python's test_a_stat_refused_eperm_reads_as_absent.
  it('reads a stat refused EPERM as absent', async () => {
    expect(
      await evalFlat(
        failingStat((path) => fsError(path, 'EPERM')),
        ['-e', '/data/b'],
      ),
    ).toBe(false)
  })

  // Mirrors python's test_a_policy_refusal_stays_loud. A store's refusal reads
  // as false; a policy's keeps its own line.
  it('keeps a policy refusal loud', async () => {
    await expect(
      evalFlat(
        failingStat((path) => new PolicyDenied('Permission denied', path.virtual)),
        ['-e', '/data/b'],
      ),
    ).rejects.toBeInstanceOf(PolicyDenied)
  })

  // Mirrors python's test_a_failing_stat_other_than_a_refusal_still_raises.
  it('still raises a failing stat other than a refusal', async () => {
    await expect(
      evalFlat(
        failingStat((path) => fsError(path, 'EIO')),
        ['-e', '/data/b'],
      ),
    ).rejects.toMatchObject({
      code: 'EIO',
    })
  })

  it('reaches a term before a grammar error after it', async () => {
    const run = evalFlat(ctx(), ['1', '-eq', 'x', '-a'])
    await expect(run).rejects.toBeInstanceOf(CondError)
    await expect(run).rejects.toThrow('x: integer expression expected')
  })
})
