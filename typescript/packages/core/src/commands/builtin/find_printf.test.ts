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
import { parseFindExpression } from '../../rs/find.ts'
import { expandPrintf as render, type PrintfStatFacts } from './find_printf.ts'
import type { Identity } from './utils/identity.ts'

function compiled(fmt: string) {
  const expr = parseFindExpression(['-printf', fmt])
  const action = expr.actions[0]
  if (action?.kind !== 'printf') throw new Error('not a -printf')
  return { action, warnings: expr.warnings }
}

function expandPrintf(
  fmt: string,
  row: string,
  base: string,
  st: PrintfStatFacts | null,
  warnings: string[],
  identity: Identity | null = null,
): string {
  const { action, warnings: found } = compiled(fmt)
  warnings.push(...found)
  return render(action.parts, row, base, st, identity)
}

function printfNeedsStat(fmt: string): boolean {
  return compiled(fmt).action.stat
}

describe('expandPrintf', () => {
  const stat = {
    size: 6,
    kind: 'f' as const,
    mtimeEpoch: 1786887930,
    mode: null,
    targetKind: null,
    uid: null,
    gid: null,
  }

  it('expands the owner family from the identity', () => {
    const warnings: string[] = []
    const identity = { profile: 'admin' }
    // No uid/gid on the entry: the owner and the group are the session's
    // profile, the rule ls -l draws its columns by.
    expect(expandPrintf('%u %U %g %G\n', '/data/a.txt', '/data', stat, warnings, identity)).toBe(
      'admin admin admin admin\n',
    )
    // A reported owner wins; `-` when nothing names one.
    const owned = { ...stat, uid: 501, gid: 'staff' }
    expect(expandPrintf('%u %g\n', '/data/a.txt', '/data', owned, warnings, identity)).toBe(
      '501 staff\n',
    )
    expect(expandPrintf('%u %g\n', '/data/a.txt', '/data', stat, warnings)).toBe('- -\n')
    expect(printfNeedsStat('%u %g\n')).toBe(true)
    expect(warnings).toEqual([])
  })

  it('expands the path family', () => {
    const warnings: string[] = []
    expect(expandPrintf('%p|%P|%f|%h|%d\n', '/data/sub/b.txt', '/data', null, warnings)).toBe(
      '/data/sub/b.txt|sub/b.txt|b.txt|/data/sub|2\n',
    )
    expect(warnings).toEqual([])
  })

  it('expands the stat family', () => {
    const warnings: string[] = []
    expect(expandPrintf('%s %y %m %M\n', '/data/a.txt', '/data', stat, warnings)).toBe(
      '6 f 644 -rw-r--r--\n',
    )
    expect(
      expandPrintf(
        '%y %m\n',
        '/data/sub',
        '/data',
        { size: 0, kind: 'd', mtimeEpoch: 0, mode: null, targetKind: null, uid: null, gid: null },
        warnings,
      ),
    ).toBe('d 755\n')
  })

  it('renders a reported mode over the per-kind default', () => {
    const warnings: string[] = []
    expect(
      expandPrintf('%m %M\n', '/data/a.txt', '/data', { ...stat, mode: 0o600 }, warnings),
    ).toBe('600 -rw-------\n')
    expect(
      expandPrintf(
        '%m %M\n',
        '/data/sub',
        '/data',
        { size: 0, kind: 'd', mtimeEpoch: 0, mode: 0o700, targetKind: null, uid: null, gid: null },
        warnings,
      ),
    ).toBe('700 drwx------\n')
  })

  it('reports the target kind for %Y on a link, N when it dangles', () => {
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
      expandPrintf('%y %Y\n', '/data/lnk', '/data', { ...link, targetKind: 'd' }, warnings),
    ).toBe('l d\n')
    expect(
      expandPrintf('%y %Y\n', '/data/lnk', '/data', { ...link, targetKind: 'N' }, warnings),
    ).toBe('l N\n')
    expect(expandPrintf('%y %Y\n', '/data/a.txt', '/data', stat, warnings)).toBe('f f\n')
  })

  it('expands time directives in UTC', () => {
    const warnings: string[] = []
    expect(expandPrintf('%TY-%Tm-%Td\n', '/data/a.txt', '/data', stat, warnings)).toBe(
      '2026-08-16\n',
    )
    expect(expandPrintf('%T@\n', '/data/a.txt', '/data', stat, warnings)).toBe(
      '1786887930.0000000000\n',
    )
  })

  it('takes a fraction before 1970 from the calendar second', () => {
    const before = { ...stat, mtimeEpoch: -0.25 }
    expect(expandPrintf('%T@|%TS|%T+\n', '/data/a.txt', '/data', before, [])).toBe(
      '-1.7500000000|59.7500000000|1969-12-31+23:59:59.7500000000\n',
    )
  })

  it('keeps a fraction to its microseconds', () => {
    const fractional = { ...stat, mtimeEpoch: Date.parse('2024-03-05T14:07:09.123Z') / 1000 }
    expect(expandPrintf('%T@|%TS|%Ts\n', '/data/a.txt', '/data', fractional, [])).toBe(
      '1709647629.1230000000|09.1230000000|1709647629\n',
    )
  })

  it('keeps a year below 100 in the ISO week and the day of the year', () => {
    const early = { ...stat, mtimeEpoch: -62008934400 }
    expect(expandPrintf('%TF|%TG|%TV|%Tj|%Tg\n', '/data/a.txt', '/data', early, [])).toBe(
      '0005-01-06|5|01|006|05\n',
    )
    const first = { ...stat, mtimeEpoch: -62009366400 }
    expect(expandPrintf('%TG|%TV\n', '/data/a.txt', '/data', first, [])).toBe('4|53\n')
  })

  it('handles escapes and warns per unknown directive in GNU words', () => {
    const warnings: string[] = []
    expect(expandPrintf('A\\tB\\n', '/data/a.txt', '/data', null, warnings)).toBe('A\tB\n')
    expect(expandPrintf('%Q\n', '/data/a.txt', '/data', null, warnings)).toBe('%Q\n')
    expect(expandPrintf('%Q\n', '/data/a.txt', '/data', null, warnings)).toBe('%Q\n')
    expect(warnings).toEqual([
      "find: warning: unrecognized format directive `%Q'",
      "find: warning: unrecognized format directive `%Q'",
    ])
  })

  it('renders the start row at depth 0', () => {
    const warnings: string[] = []
    expect(expandPrintf('%P|%d|%f\n', '/data', '/data', null, warnings)).toBe('|0|data\n')
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
