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
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { GENERAL_DATE } from './date.ts'

const DEC = new TextDecoder()

async function runDate(
  texts: string[] = [],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<string> {
  const resource = new RAMResource()
  const cmd = GENERAL_DATE[0]
  if (cmd === undefined) throw new Error('date not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('date', () => {
  it('-I returns ISO date', async () => {
    const fixed = '2026-04-21T12:00:00Z'
    const out = await runDate([], { d: fixed, args_I: true })
    expect(out).toBe('2026-04-21\n')
  })

  it('-d with custom format', async () => {
    const out = await runDate(['+%Y-%m-%d'], { d: '2026-04-21T12:00:00Z', u: true })
    expect(out).toBe('2026-04-21\n')
  })

  it('+%H:%M:%S UTC', async () => {
    const out = await runDate(['+%H:%M:%S'], { d: '2026-04-21T13:45:30Z', u: true })
    expect(out).toBe('13:45:30\n')
  })

  it('default format roughly matches "Day Mon DD HH:MM:SS YYYY"', async () => {
    const out = await runDate([], { d: '2026-04-21T12:00:00', u: true })
    // Tue Apr 21 12:00:00 UTC 2026
    expect(out).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} (UTC )?2026\n$/)
  })

  it('-R RFC5322 format', async () => {
    const out = await runDate([], { d: '2026-04-21T12:00:00Z', u: true, R: true })
    expect(out).toBe('Tue, 21 Apr 2026 12:00:00 +0000\n')
  })

  it('+%s seconds since epoch', async () => {
    const out = await runDate(['+%s'], { d: '2026-04-21T00:00:00Z', u: true })
    // 2026-04-21T00:00:00Z = 1777305600
    expect(out.trim()).toBe(String(Math.floor(Date.UTC(2026, 3, 21) / 1000)))
  })
})

async function runDateIo(
  texts: string[] = [],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<[string, string, number]> {
  const resource = new RAMResource()
  const cmd = GENERAL_DATE[0]
  if (cmd === undefined) throw new Error('date not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return ['', '', 0]
  const [out, io] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const errRaw =
    io.stderr === null
      ? new Uint8Array()
      : io.stderr instanceof Uint8Array
        ? io.stderr
        : await materialize(io.stderr as AsyncIterable<Uint8Array>)
  return [DEC.decode(buf), DEC.decode(errRaw), io.exitCode]
}

describe('date GNU format specifiers', () => {
  const AT = '2026-08-16T13:45:30Z'

  it('+%F renders the ISO date, not the literal', async () => {
    expect(await runDate(['+%F %T'], { d: AT, u: true })).toBe('2026-08-16 13:45:30\n')
  })

  it('renders 12-hour, quarter, century, and padded-hour forms', async () => {
    expect(await runDate(['+%r|%q|%C|%h|%k|%l|%P|%R'], { d: AT, u: true })).toBe(
      '01:45:30 PM|3|20|Aug|13| 1|pm|13:45\n',
    )
  })

  it('renders week numbers and the ISO week-based year', async () => {
    expect(await runDate(['+%V|%U|%W|%G|%g'], { d: AT, u: true })).toBe('33|33|32|2026|26\n')
  })

  it('renders C-locale %c, %x, %X and the %n/%t escapes', async () => {
    expect(await runDate(['+%c|%x|%X|%n|%t'], { d: AT, u: true })).toBe(
      'Sun Aug 16 13:45:30 2026|08/16/26|13:45:30|\n|\t\n',
    )
  })

  it('passes an unknown directive through literally, as GNU does', async () => {
    expect(await runDate(['+%v'], { d: AT, u: true })).toBe('%v\n')
  })
})

describe('date -d expressions', () => {
  it('handles a relative displacement from an ISO base', async () => {
    const out = await runDate(['+%F %T'], { d: '2026-08-16 12:00:00 24 hours ago', u: true })
    expect(out).toBe('2026-08-15 12:00:00\n')
  })

  it('handles @epoch input', async () => {
    expect(await runDate(['+%F %T'], { d: '@1755300000', u: true })).toBe('2025-08-15 23:20:00\n')
  })

  it('normalizes month overflow the way GNU does', async () => {
    expect(await runDate(['+%F'], { d: '2026-01-31 1 month', u: true })).toBe('2026-03-03\n')
  })

  it('produces a date, never NaN, for a bare relative expression', async () => {
    const out = await runDate(['+%F'], { d: '24 hours ago', u: true })
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}\n$/)
  })

  it('refuses an invalid date with GNU wording and exit 1', async () => {
    const [out, stderr, code] = await runDateIo([], { d: 'not a date' })
    expect(out).toBe('')
    expect(stderr).toBe("date: invalid date 'not a date'\n")
    expect(code).toBe(1)
  })
})

async function runDateEnv(
  env: Record<string, string>,
  texts: string[] = [],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<[string, string, number]> {
  const resource = new RAMResource()
  const cmd = GENERAL_DATE[0]
  if (cmd === undefined) throw new Error('date not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    env,
  })
  if (result === null) return ['', '', 0]
  const [out, io] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const err = io.stderr === null ? new Uint8Array() : await materialize(io.stderr)
  return [DEC.decode(buf), DEC.decode(err), io.exitCode]
}

// Pinned against GNU date 9.x on debian:stable-slim with tzdata: the zone
// is the command environment's TZ, `-u` outranks it, and an instant
// renders on the calendar day the zone shows (issue #1070). The zone comes
// from `opts.env` alone: process.env.TZ is never read or written.
describe('date honors the command environment TZ', () => {
  it.each([
    [{ TZ: 'UTC' }, ['+%Y-%m-%d %H:%M:%S %z'], { d: '@0' }, '1970-01-01 00:00:00 +0000\n'],
    [
      { TZ: 'Asia/Hong_Kong' },
      ['+%Y-%m-%d %H:%M:%S %z'],
      { d: '@0' },
      '1970-01-01 08:00:00 +0800\n',
    ],
    [
      { TZ: 'Asia/Hong_Kong' },
      ['+%F %T %z %Z'],
      { d: '@0', u: true },
      '1970-01-01 00:00:00 +0000 UTC\n',
    ],
    [{ TZ: 'Asia/Hong_Kong' }, ['+%F %T'], { d: '1970-01-01T20:00:00Z' }, '1970-01-02 04:00:00\n'],
    [
      { TZ: 'Asia/Hong_Kong' },
      ['+%F %T'],
      { d: '1970-01-01T20:00:00Z 1 day' },
      '1970-01-03 04:00:00\n',
    ],
    [{ TZ: 'Asia/Hong_Kong' }, ['+%s'], { d: '1970-01-01 00:00:00' }, '-28800\n'],
    [{ TZ: 'Asia/Hong_Kong' }, [], { d: '@0', R: true }, 'Thu, 01 Jan 1970 08:00:00 +0800\n'],
    [{ TZ: 'Asia/Hong_Kong' }, [], { d: '1970-01-01T20:00:00Z', args_I: true }, '1970-01-02\n'],
    [
      { TZ: 'America/Los_Angeles' },
      ['+%F %T %z'],
      { d: '@1751328000' },
      '2025-06-30 17:00:00 -0700\n',
    ],
    [{ TZ: 'Bogus/Zone' }, ['+%F %T %z %Z'], { d: '@0' }, '1970-01-01 00:00:00 +0000 Bogus\n'],
    [{ TZ: ':Asia/Tokyo' }, ['+%T %z'], { d: '@0' }, '09:00:00 +0900\n'],
    [{ TZ: 'UTC0' }, ['+%T %z %Z'], { d: '@0' }, '00:00:00 +0000 UTC\n'],
    [{ TZ: '<+0530>-5:30' }, ['+%T %z %Z %:z'], { d: '@0' }, '05:30:00 +0530 +0530 +05:30\n'],
    [
      { TZ: 'CET-1CEST,M3.5.0,M10.5.0/3' },
      ['+%F %T %z %Z'],
      { d: '@1751328000' },
      '2025-07-01 02:00:00 +0200 CEST\n',
    ],
    [
      { TZ: 'CET-1CEST,M3.5.0,M10.5.0/3' },
      ['+%s %Z'],
      { d: '2025-10-26 02:30:00' },
      '1761442200 CET\n',
    ],
    [
      { TZ: 'CET-1CEST,M3.5.0,M10.5.0/3' },
      ['+%F %T %Z'],
      { d: '2025-03-29 12:00:00 1 day' },
      '2025-03-30 12:00:00 CEST\n',
    ],
    [
      { TZ: 'CET-1CEST,M3.5.0,M10.5.0/3' },
      ['+%F %T %Z'],
      { d: '2025-03-29 12:00:00 24 hours' },
      '2025-03-30 13:00:00 CEST\n',
    ],
    [{ TZ: 'UTC' }, ['+%a %Z'], { d: '@0' }, 'Thu UTC\n'],
    [{ TZ: 'UTC' }, [], { d: '@0' }, 'Thu Jan 01 00:00:00 UTC 1970\n'],
    [{ TZ: '' }, ['+%F %T %z'], { d: '@0' }, '1970-01-01 00:00:00 +0000\n'],
    // A day shift landing in the hour CEST skips moves past the gap, and one
    // landing in the hour it repeats keeps the base's side (gnulib hands
    // mktime the base's tm_isdst).
    [
      { TZ: 'Europe/Berlin' },
      ['+%F %T %z %Z'],
      { d: '2025-03-29 02:30:00 1 day' },
      '2025-03-30 03:30:00 +0200 CEST\n',
    ],
    [
      { TZ: 'Europe/Berlin' },
      ['+%F %T %z %Z'],
      { d: '2025-10-25 02:30:00 1 day' },
      '2025-10-26 02:30:00 +0200 CEST\n',
    ],
    [
      { TZ: 'Europe/Berlin' },
      ['+%F %T %z %Z'],
      { d: '2025-10-27 02:30:00 1 day ago' },
      '2025-10-26 02:30:00 +0100 CET\n',
    ],
    // glibc keeps the names and offsets of a POSIX string whose rule it
    // refuses, and clamps an offset's minutes at 59.
    [{ TZ: 'CET-1CEST,bogus' }, ['+%z %Z'], { d: '@1720000000' }, '+0200 CEST\n'],
    [{ TZ: 'UTC5:99' }, ['+%T %z'], { d: '@0' }, '18:01:00 -0559\n'],
  ])('%j %j %j', async (env, texts, flags, expected) => {
    expect(await runDateEnv(env, texts, flags)).toEqual([expected, '', 0])
  })

  it('refuses a wall clock the zone skips', async () => {
    // glibc's mktime finds no instant for 02:30 on the night CEST starts.
    expect(
      await runDateEnv({ TZ: 'Europe/Berlin' }, ['+%s'], { d: '2025-03-30 02:30:00' }),
    ).toEqual(['', "date: invalid date '2025-03-30 02:30:00'\n", 1])
  })

  it('reads each invocation its own zone with no process state between them', async () => {
    const before = process.env.TZ
    const results = await Promise.all([
      runDateEnv({ TZ: 'Asia/Hong_Kong' }, ['+%H %z'], { d: '@0' }),
      runDateEnv({ TZ: 'UTC' }, ['+%H %z'], { d: '@0' }),
      runDateEnv({ TZ: 'Asia/Hong_Kong' }, ['+%H %z'], { d: '@0' }),
      runDateEnv({}, ['+%H %z'], { d: '@0', u: true }),
    ])
    expect(results.map((r) => r[0])).toEqual([
      '08 +0800\n',
      '00 +0000\n',
      '08 +0800\n',
      '00 +0000\n',
    ])
    expect(process.env.TZ).toBe(before)
  })
})

// `%Z` is tzdata's abbreviation in both hosts (GNU date on
// debian:stable-slim): lettered where tzdata has letters, the offset
// spelled out where it does not, and a zone's own history applies.
describe("date: %Z is tzdata's abbreviation", () => {
  it.each([
    [{ TZ: 'Asia/Hong_Kong' }, ['+%Z'], { d: '@0' }, 'HKT\n'],
    [{ TZ: 'Europe/London' }, ['+%Z'], { d: '@1751328000' }, 'BST\n'],
    [{ TZ: 'Europe/London' }, ['+%Z'], { d: '@1735689600' }, 'GMT\n'],
    [{ TZ: 'Australia/Sydney' }, ['+%Z'], { d: '@1751328000' }, 'AEST\n'],
    [{ TZ: 'Australia/Sydney' }, ['+%Z'], { d: '@1735689600' }, 'AEDT\n'],
    [{ TZ: 'Asia/Kolkata' }, ['+%Z %z'], { d: '@0' }, 'IST +0530\n'],
    [{ TZ: 'Asia/Singapore' }, ['+%Z'], { d: '@0' }, '+0730\n'],
    [{ TZ: 'Asia/Singapore' }, ['+%Z'], { d: '@1751328000' }, '+08\n'],
    [{ TZ: 'America/Sao_Paulo' }, ['+%Z'], { d: '@0' }, '-03\n'],
    [{ TZ: 'Etc/GMT+5' }, ['+%Z'], { d: '@0' }, '-05\n'],
    [{ TZ: 'Europe/Moscow' }, ['+%Z %z'], { d: '@1340000000' }, 'MSK +0400\n'],
    [{ TZ: 'Europe/Moscow' }, ['+%Z %z'], { d: '@1276848800' }, 'MSD +0400\n'],
    [{ TZ: 'Europe/Istanbul' }, ['+%Z'], { d: '@1435752000' }, 'EEST\n'],
    [{ TZ: 'Europe/Istanbul' }, ['+%Z'], { d: '@1498906800' }, '+03\n'],
  ])('%j %j %j', async (env, texts, flags, expected) => {
    expect(await runDateEnv(env, texts, flags)).toEqual([expected, '', 0])
  })
})

it('renders the implicit host zone in explicit and default formats', async () => {
  const hostZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  for (const d of ['@1789430400', '@1767225600']) {
    for (const format of [[], ['+%Z %z']]) {
      const implicit = await runDateEnv({}, format, { d })
      expect(implicit).toEqual(await runDateEnv({ TZ: hostZone }, format, { d }))
      expect(implicit[0].trim()).not.toBe('')
    }
  }
})
