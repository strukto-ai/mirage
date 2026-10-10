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
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { GENERAL_DATE } from './date.ts'

const DEC = new TextDecoder()

async function runDate(
  texts: string[] = [],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<string> {
  const vfs = new RAMVFS()
  const cmd = GENERAL_DATE[0]
  if (cmd === undefined) throw new Error('date not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    cwd: '/',
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

async function runDateIo(
  texts: string[] = [],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<[string, string, number]> {
  const vfs = new RAMVFS()
  const cmd = GENERAL_DATE[0]
  if (cmd === undefined) throw new Error('date not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
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

  it('renders week numbers and the ISO week-based year', async () => {
    expect(await runDate(['+%V|%U|%W|%G|%g'], { date: AT, utc: true })).toBe('33|33|32|2026|26\n')
  })

  it('renders C-locale %c, %x, %X and the %n/%t escapes', async () => {
    expect(await runDate(['+%c|%x|%X|%n|%t'], { date: AT, utc: true })).toBe(
      'Sun Aug 16 13:45:30 2026|08/16/26|13:45:30|\n|\t\n',
    )
  })
})

describe('date -d expressions', () => {
  it('produces a date, never NaN, for a bare relative expression', async () => {
    const out = await runDate(['+%F'], { date: '24 hours ago', utc: true })
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}\n$/)
  })

  // GNU ACCEPTS an empty (or blank) `-d`, exit 0, at today 00:00:00:
  // gnulib's parse-datetime sees no component at all and falls through to
  // "a date with no time". Measured on coreutils 9.4 under
  // `LC_ALL=C TZ=UTC`. mirage used to answer `date: invalid date ''` and
  // exit 1. Mirrors test_date.py.
  it('reads an empty expression as today at midnight', async () => {
    const [out, stderr, code] = await runDateIo(['+%H:%M:%S'], { date: '', utc: true })
    expect([out, stderr, code]).toEqual(['00:00:00\n', '', 0])
    const day = await runDate(['+%Y-%m-%d'], { date: '', utc: true })
    expect(day).toBe(await runDate(['+%Y-%m-%d'], { utc: true }))
  })
})

async function runDateEnv(
  env: Record<string, string>,
  texts: string[] = [],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<[string, string, number]> {
  const vfs = new RAMVFS()
  const cmd = GENERAL_DATE[0]
  if (cmd === undefined) throw new Error('date not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
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
    [{ TZ: 'UTC' }, ['+%a %Z'], { date: '@0' }, 'Thu UTC\n'],
    [{ TZ: 'UTC' }, [], { date: '@0' }, 'Thu Jan  1 00:00:00 UTC 1970\n'],
  ])('%j %j %j', async (env, texts, flags, expected) => {
    expect(await runDateEnv(env, texts, flags)).toEqual([expected, '', 0])
  })

  it('reads each invocation its own zone with no process state between them', async () => {
    const before = process.env.TZ
    const results = await Promise.all([
      runDateEnv({ TZ: 'Asia/Hong_Kong' }, ['+%H %z'], { date: '@0' }),
      runDateEnv({ TZ: 'UTC' }, ['+%H %z'], { date: '@0' }),
      runDateEnv({ TZ: 'Asia/Hong_Kong' }, ['+%H %z'], { date: '@0' }),
      runDateEnv({}, ['+%H %z'], { date: '@0', utc: true }),
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

it('renders the implicit host zone in explicit and default formats', async () => {
  const hostZone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  for (const d of ['@1789430400', '@1767225600']) {
    for (const format of [[], ['+%Z %z']]) {
      const implicit = await runDateEnv({}, format, { date: d })
      expect(implicit).toEqual(await runDateEnv({ TZ: hostZone }, format, { date: d }))
      expect(implicit[0].trim()).not.toBe('')
    }
  }
})

// `date -d` names the refused expression through gnulib's quote(), so a
// byte outside 0x20-0x7e comes back escaped rather than interpolated raw.
// Every row measured against GNU coreutils 9.4 under `LC_ALL=C` with a raw
// `bytes` argv (`date -d x<B>`). Mirrors test_date.py.
async function runDateStderr(d: string): Promise<[string, number]> {
  const vfs = new RAMVFS()
  const cmd = GENERAL_DATE[0]
  if (cmd === undefined) throw new Error('date not registered')
  const result = await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], [], {
    stdin: null,
    flags: { date: d },
    cwd: '/',
  })
  if (result === null) throw new Error('date returned no result')
  await materialize(result[0])
  const [, io] = result
  return [DEC.decode(io.stderr as Uint8Array), io.exitCode]
}

describe('date quotes the expression it refuses', () => {
  it.each([
    ['xé', 'x\\303\\251'],
    ['x\\', 'x\\\\'],
  ])('escapes %j in the invalid-date clause', async (value, escaped) => {
    expect(await runDateStderr(value)).toEqual([`date: invalid date '${escaped}'\n`, 1])
  })
})

describe('date output formats through the shell', () => {
  // GNU's output formats, one per option, measured on coreutils 9.7
  // (debian:stable-slim): -I[FMT] takes its precision attached or after `=`
  // and matches it by prefix, --rfc-3339=FMT takes the narrower set, and a
  // line with no format option prints `%e`, a space-padded day. Mirrors
  // test_date.py.
  const AT = '2024-03-05T07:08:09.5Z'
  const ISO_VALID =
    "Valid arguments are:\n  - 'hours'\n  - 'minutes'\n  - 'date'\n  - 'seconds'\n  - 'ns'\n" +
    "Try 'date --help' for more information.\n"

  async function makeWs(): Promise<Workspace> {
    const parser = await getTestParser()
    const ram = new RAMVFS()
    return new Workspace({ '/ram': ram }, { mode: MountMode.WRITE, shellParser: parser })
  }

  it.each([
    [`date -d ${AT} -Isu`, "date: invalid argument 'su' for '--iso-8601'\n" + ISO_VALID],
    [`date -d ${AT} -I -R a b`, 'date: multiple output formats specified\n'],
  ])('%s refuses', async (line, err) => {
    const ws = await makeWs()
    const io = await ws.shell(line)
    await ws.close()
    expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual(['', err, 1])
  })
})
