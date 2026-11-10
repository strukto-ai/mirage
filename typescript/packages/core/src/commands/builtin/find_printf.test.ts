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

import { describe, expect, it, vi } from 'vitest'
import { parseFindExpression } from '../../rs/find.ts'
import { decodeText } from '../../shell/bytes.ts'
import { compilePrintf, renderPrintf, type PrintfStatFacts } from './find_printf.ts'
import type { Identity } from './utils/identity.ts'

function compiled(fmt: string) {
  const expr = parseFindExpression(['-printf', fmt])
  const action = expr.actions[0]
  if (action?.kind !== 'printf') throw new Error('not a -printf')
  return { action, warnings: expr.warnings }
}

async function expand(
  fmt: string,
  row: string,
  base: string,
  st: PrintfStatFacts | null,
  warnings: string[],
  identity: Identity | null = null,
): Promise<string> {
  const { action, warnings: found } = compiled(fmt)
  warnings.push(...found)
  const engine = compilePrintf(action.parts)
  const out = await renderPrintf(engine, row, base, st, identity)
  engine.close()
  return decodeText(out)
}

function printfNeedsStat(fmt: string): boolean {
  return compiled(fmt).action.stat
}

describe('renderPrintf', () => {
  const stat = {
    size: 6,
    kind: 'f' as const,
    mtimeEpoch: 1786887930,
    mode: null,
    targetKind: null,
    uid: null,
    gid: null,
  }

  it('expands the owner family from the identity', async () => {
    const warnings: string[] = []
    const identity = { profile: 'admin' }
    // No uid/gid on the entry: the owner and the group are the session's
    // profile, the rule ls -l draws its columns by.
    expect(await expand('%u %U %g %G\n', '/data/a.txt', '/data', stat, warnings, identity)).toBe(
      'admin admin admin admin\n',
    )
    // A reported owner wins; `-` when nothing names one.
    const owned = { ...stat, uid: 501, gid: 'staff' }
    expect(await expand('%u %g\n', '/data/a.txt', '/data', owned, warnings, identity)).toBe(
      '501 staff\n',
    )
    expect(await expand('%u %g\n', '/data/a.txt', '/data', stat, warnings)).toBe('- -\n')
    expect(printfNeedsStat('%u %g\n')).toBe(true)
    expect(warnings).toEqual([])
  })

  it('expands the path family', async () => {
    const warnings: string[] = []
    expect(await expand('%p|%P|%f|%h|%d\n', '/data/sub/b.txt', '/data', null, warnings)).toBe(
      '/data/sub/b.txt|sub/b.txt|b.txt|/data/sub|2\n',
    )
    expect(warnings).toEqual([])
  })

  it('expands the stat family', async () => {
    const warnings: string[] = []
    expect(await expand('%s %y %m %M\n', '/data/a.txt', '/data', stat, warnings)).toBe(
      '6 f 644 -rw-r--r--\n',
    )
    expect(
      await expand(
        '%y %m\n',
        '/data/sub',
        '/data',
        { size: 0, kind: 'd', mtimeEpoch: 0, mode: null, targetKind: null, uid: null, gid: null },
        warnings,
      ),
    ).toBe('d 755\n')
  })

  it('renders a reported mode over the per-kind default', async () => {
    const warnings: string[] = []
    expect(
      await expand('%m %M\n', '/data/a.txt', '/data', { ...stat, mode: 0o600 }, warnings),
    ).toBe('600 -rw-------\n')
    expect(
      await expand(
        '%m %M\n',
        '/data/sub',
        '/data',
        { size: 0, kind: 'd', mtimeEpoch: 0, mode: 0o700, targetKind: null, uid: null, gid: null },
        warnings,
      ),
    ).toBe('700 drwx------\n')
  })

  it('reports the target kind for %Y on a link, N when it dangles', async () => {
    const warnings: string[] = []
    const link = {
      size: 5,
      kind: 'l' as const,
      mtimeEpoch: 0,
      mode: null,
      targetKind: null,
      uid: null,
      gid: null,
    }
    expect(
      await expand('%y %Y\n', '/data/lnk', '/data', { ...link, targetKind: 'd' }, warnings),
    ).toBe('l d\n')
    expect(
      await expand('%y %Y\n', '/data/lnk', '/data', { ...link, targetKind: 'N' }, warnings),
    ).toBe('l N\n')
    expect(await expand('%y %Y\n', '/data/a.txt', '/data', stat, warnings)).toBe('f f\n')
  })

  it('expands time directives in UTC', async () => {
    const warnings: string[] = []
    expect(await expand('%TY-%Tm-%Td\n', '/data/a.txt', '/data', stat, warnings)).toBe(
      '2026-08-16\n',
    )
    expect(await expand('%T@\n', '/data/a.txt', '/data', stat, warnings)).toBe(
      '1786887930.0000000000\n',
    )
  })

  it('takes a fraction before 1970 from the calendar second', async () => {
    const before = { ...stat, mtimeEpoch: -0.25 }
    expect(await expand('%T@|%TS|%T+\n', '/data/a.txt', '/data', before, [])).toBe(
      '-1.7500000000|59.7500000000|1969-12-31+23:59:59.7500000000\n',
    )
  })

  it('keeps a fraction to its microseconds', async () => {
    const fractional = { ...stat, mtimeEpoch: Date.parse('2024-03-05T14:07:09.123Z') / 1000 }
    expect(await expand('%T@|%TS|%Ts\n', '/data/a.txt', '/data', fractional, [])).toBe(
      '1709647629.1230000000|09.1230000000|1709647629\n',
    )
  })

  it('keeps a year below 100 in the ISO week and the day of the year', async () => {
    const early = { ...stat, mtimeEpoch: -62008934400 }
    expect(await expand('%TF|%TG|%TV|%Tj|%Tg\n', '/data/a.txt', '/data', early, [])).toBe(
      '0005-01-06|5|01|006|05\n',
    )
    const first = { ...stat, mtimeEpoch: -62009366400 }
    expect(await expand('%TG|%TV\n', '/data/a.txt', '/data', first, [])).toBe('4|53\n')
  })

  it('handles escapes and warns per unknown directive in GNU words', async () => {
    const warnings: string[] = []
    expect(await expand('A\\tB\\n', '/data/a.txt', '/data', null, warnings)).toBe('A\tB\n')
    expect(await expand('%Q\n', '/data/a.txt', '/data', null, warnings)).toBe('%Q\n')
    expect(await expand('%Q\n', '/data/a.txt', '/data', null, warnings)).toBe('%Q\n')
    expect(warnings).toEqual([
      "find: warning: unrecognized format directive `%Q'",
      "find: warning: unrecognized format directive `%Q'",
    ])
  })

  it('renders the start row at depth 0', async () => {
    const warnings: string[] = []
    expect(await expand('%P|%d|%f\n', '/data', '/data', null, warnings)).toBe('|0|data\n')
  })
})

describe('printfNeedsStat', () => {
  it('detects stat directives', () => {
    expect(printfNeedsStat('%s\n')).toBe(true)
    expect(printfNeedsStat('%TY\n')).toBe(true)
    expect(printfNeedsStat('%p %f %h %P %d\n')).toBe(false)
    expect(printfNeedsStat('100%%score\n')).toBe(false)
  })
})

it('honors an abort while formatting a final row', async () => {
  const { action } = compiled('x'.repeat(1 << 18))
  const engine = compilePrintf(action.parts)
  const abort = new AbortController()
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 20))
  const timer = setImmediate(() => {
    abort.abort()
  })
  try {
    await expect(
      renderPrintf(engine, '/data/a', '/data', null, null, abort.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    clearImmediate(timer)
    clock.mockRestore()
    engine.close()
  }
})
