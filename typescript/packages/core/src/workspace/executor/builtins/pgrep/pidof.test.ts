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
import { handlePidof } from './pidof.ts'

describe('pidof', () => {
  it('prints the newest first on one line', async () => {
    const [table, jobs] = await withJobs('sleep 30', 'sleep 31')
    const first = String(jobs[0]?.pid)
    const second = String(jobs[1]?.pid)
    expect(text(await handlePidof(table, ['pidof', 'sleep']))[0]).toBe(`${second} ${first}\n`)
    expect(text(await handlePidof(table, ['pidof', '-s', 'sleep']))[0]).toBe(`${second}\n`)
    expect(text(await handlePidof(table, ['pidof', '-d,', 'sleep']))[0]).toBe(
      `${second},${first}\n`,
    )
    await stop(table, jobs)
  })

  it('says nothing finding nothing or on a bad option', async () => {
    const table = new JobTable()
    expect(text(await handlePidof(table, ['pidof', 'nosuch']))).toEqual(['', '', 1])
    expect(text(await handlePidof(table, ['pidof', '--foo']))).toEqual(['', '', 1])
    expect(text(await handlePidof(table, ['pidof']))).toEqual(['', '', 1])
  })
})
