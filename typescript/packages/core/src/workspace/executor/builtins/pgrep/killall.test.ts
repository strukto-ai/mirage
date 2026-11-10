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
import { handleKillall } from './killall.ts'

describe('killall', () => {
  it('signals by exact name', async () => {
    const [table, jobs] = await withJobs('sleep 30')
    expect(text(await handleKillall(table, ['killall', 'slee']))[2]).toBe(1)
    expect(text(await handleKillall(table, ['killall', '-v', 'sleep']))).toEqual([
      `Killed sleep(${String(jobs[0]?.pid)}) with signal 15\n`,
      '',
      0,
    ])
  })

  it('says which name found nothing', async () => {
    const [table, jobs] = await withJobs('sleep 30')
    expect(text(await handleKillall(table, ['killall', 'sleep', 'nosuch']))).toEqual([
      '',
      'nosuch: no process found\n',
      1,
    ])
    await stop(table, jobs)
  })

  it('is quiet, ignores case and reads regular expressions', async () => {
    const [table, jobs] = await withJobs('sleep 30', 'sleep 31')
    expect(text(await handleKillall(table, ['killall', '-q', 'nosuch']))).toEqual(['', '', 1])
    expect(text(await handleKillall(table, ['killall', '-I', 'SLEEP']))[2]).toBe(0)
    const [other, more] = await withJobs('sleep 30')
    expect(text(await handleKillall(other, ['killall', '-r', 'sl.*']))[2]).toBe(0)
    await stop(table, jobs)
    await stop(other, more)
  })

  it.each([
    [['-SIGNOPE', 'x'], 'NOPE: unknown signal; killall -l lists signals.\n'],
    [['-s', 'NOPE', 'x'], 'NOPE: unknown signal; killall -l lists signals.\n'],
    [['-r', '('], 'killall: Bad regular expression: (\n'],
  ])('refuses %j', async (words: string[], said: string) => {
    expect(text(await handleKillall(new JobTable(), ['killall', ...words])).slice(1)).toEqual([
      said,
      1,
    ])
  })

  it('lists signals', async () => {
    const [out, , code] = text(await handleKillall(new JobTable(), ['killall', '-l']))
    expect(out.startsWith('HUP INT QUIT ILL')).toBe(true)
    expect(code).toBe(0)
  })
})
