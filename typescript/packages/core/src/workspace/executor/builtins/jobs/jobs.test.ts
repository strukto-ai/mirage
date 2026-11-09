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
import { handleJobs } from './jobs.ts'
import { pendingRun, quiet } from '../../../../../tests/workspace/fixtures/job_runners.ts'

function decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

describe('handleJobs', () => {
  it('returns empty output when no jobs', async () => {
    const jt = new JobTable()
    const [out, io] = await handleJobs(jt, ['jobs'])
    expect((out as Uint8Array).byteLength).toBe(0)
    expect(io.exitCode).toBe(0)
  })

  it('lists jobs with id, status, command', async () => {
    const jt = new JobTable()
    const j = await jt.submit({
      command: 'foo',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    const abort = new AbortController()
    const task = pendingRun(abort)
    await jt.submit({ command: 'bar', run: task, abort, cwd: '/' })
    await jt.wait(j.id)
    const [out] = await handleJobs(jt, ['jobs'])
    const text = decode(out as Uint8Array)
    expect(text).toContain('[1]-  Done                    foo\n')
    expect(text).toContain('[2]+  Running                 bar &\n')
  })

  it('removes completed jobs from the table', async () => {
    const jt = new JobTable()
    const j = await jt.submit({
      command: 'foo',
      run: quiet,
      abort: new AbortController(),
      cwd: '/',
    })
    await jt.wait(j.id)
    await handleJobs(jt, ['jobs'])
    expect(jt.listJobs()).toHaveLength(0)
  })
})
