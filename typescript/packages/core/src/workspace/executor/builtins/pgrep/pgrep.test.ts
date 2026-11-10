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
import { JobTable } from '../../../../execution/job/index.ts'
import { stop, text, withJobs } from '../../../../../tests/workspace/fixtures/process_search.ts'
import { handlePgrep, handlePkill } from './pgrep.ts'

describe('pgrep', () => {
  it('finds by name', async () => {
    const [table, jobs] = await withJobs('sleep 30', 'cat big')
    expect(text(await handlePgrep(table, ['pgrep', 'sleep'])).slice(0, 1)).toEqual([
      `${String(jobs[0]?.pid)}\n`,
    ])
    await stop(table, jobs)
  })

  it('reads a regular expression and, with -f, the arguments', async () => {
    const [table, jobs] = await withJobs('sleep 30')
    expect(text(await handlePgrep(table, ['pgrep', 'sl.*p']))[2]).toBe(0)
    expect(text(await handlePgrep(table, ['pgrep', '30']))[2]).toBe(1)
    expect(text(await handlePgrep(table, ['pgrep', '-f', '30']))[2]).toBe(0)
    await stop(table, jobs)
  })

  it('takes options after the pattern', async () => {
    const [table, jobs] = await withJobs('sleep 30')
    expect(text(await handlePgrep(table, ['pgrep', 'sleep', '-c']))[0]).toBe('1\n')
    await stop(table, jobs)
  })

  it('counts, lists and joins', async () => {
    const [table, jobs] = await withJobs('sleep 30', 'sleep 31')
    const first = String(jobs[0]?.pid)
    const second = String(jobs[1]?.pid)
    expect(text(await handlePgrep(table, ['pgrep', '-c', 'sleep']))[0]).toBe('2\n')
    expect(text(await handlePgrep(table, ['pgrep', '-l', 'sleep']))[0]).toBe(
      `${first} sleep\n${second} sleep\n`,
    )
    expect(text(await handlePgrep(table, ['pgrep', '-a', 'sleep']))[0]).toBe(
      `${first} sleep 30\n${second} sleep 31\n`,
    )
    expect(text(await handlePgrep(table, ['pgrep', '-d,', 'sleep']))[0]).toBe(
      `${first},${second}\n`,
    )
    expect(text(await handlePgrep(table, ['pgrep', '-n', 'sleep']))[0]).toBe(`${second}\n`)
    expect(text(await handlePgrep(table, ['pgrep', '-o', 'sleep']))[0]).toBe(`${first}\n`)
    await stop(table, jobs)
  })

  it('matches exactly, in any case, or inverted', async () => {
    const [table, jobs] = await withJobs('sleep 30')
    expect(text(await handlePgrep(table, ['pgrep', '-x', 'slee']))[2]).toBe(1)
    expect(text(await handlePgrep(table, ['pgrep', '-x', 'sleep']))[2]).toBe(0)
    expect(text(await handlePgrep(table, ['pgrep', '-i', 'SLEEP']))[2]).toBe(0)
    expect(text(await handlePgrep(table, ['pgrep', '-v', 'sleep']))[2]).toBe(1)
    await stop(table, jobs)
  })

  it.each([
    [[], "pgrep: no matching criteria specified\nTry `pgrep --help' for more information.\n"],
    [
      ['a', 'b'],
      "pgrep: only one pattern can be provided\nTry `pgrep --help' for more information.\n",
    ],
    [['-P', 'abc'], 'pgrep: not a number: abc\n'],
    [['('], 'pgrep: regex error: Unmatched ( or \\(\n'],
  ])('refuses %j', async (words: string[], said: string) => {
    expect(text(await handlePgrep(new JobTable(), ['pgrep', ...words])).slice(1)).toEqual([said, 2])
  })

  it('warns of a name too long to match', async () => {
    const [, err, code] = text(
      await handlePgrep(new JobTable(), ['pgrep', 'averyveryverylongname']),
    )
    expect(err).toContain('longer than 15 characters')
    expect(code).toBe(1)
  })
})

describe('pkill', () => {
  it('signals what it finds', async () => {
    const [table, jobs] = await withJobs('sleep 30', 'cat big')
    const [out, , code] = text(await handlePkill(table, ['pkill', '-e', 'sleep']))
    expect([out, code]).toEqual([`sleep killed (pid ${String(jobs[0]?.pid)})\n`, 0])
    await stop(table, jobs.slice(1))
  })

  it('takes a signal first', async () => {
    const [table] = await withJobs('sleep 30')
    expect(text(await handlePkill(table, ['pkill', '-KILL', 'sleep']))[2]).toBe(0)
  })

  it('answers 1 finding nothing', async () => {
    expect(text(await handlePkill(new JobTable(), ['pkill', 'nosuch']))[2]).toBe(1)
  })

  it('reads a bad signal as an option', async () => {
    const [, err, code] = text(await handlePkill(new JobTable(), ['pkill', '-NOPE', 'x']))
    expect(err.startsWith("pkill: invalid option -- 'N'\n")).toBe(true)
    expect(code).toBe(2)
  })
})
