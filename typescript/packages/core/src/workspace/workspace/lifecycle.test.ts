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

import { beforeAll, describe, expect, it } from 'vitest'

import { IOResult } from '../../io/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { type JobRunner, JobStatus } from '../../shell/job_table/index.ts'
import type { ShellParser } from '../../shell/parse/index.ts'
import { MountMode } from '../../types.ts'
import { ExecutionNode } from '../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

let parser: ShellParser

beforeAll(async () => {
  parser = await getTestParser()
})

function buildWs(): Workspace {
  return new Workspace(
    { '/m': [new RAMResource(), MountMode.WRITE] },
    { mode: MountMode.WRITE, shellParser: parser },
  )
}

/**
 * A runner that never observes the abort signal, like a long command
 * that does not check it. Only `release.fire()` ends it.
 *
 * Deliberately not `sleep`: it is the one command that consumes the
 * signal, so it settles through its own runner and would pass even when
 * teardown only aborts.
 */
function deaf(release: { fire?: () => void }): JobRunner {
  return async () => {
    await new Promise<void>((resolve) => {
      release.fire = resolve
    })
    return [new IOResult(), new ExecutionNode()]
  }
}

describe('closeWorkspace', () => {
  // A bare abort leaves such a job RUNNING with no ending chunk, so
  // anyone parked on waitFinished waits forever on a workspace that is
  // already gone. killAll never joins the runner, so settling here
  // cannot block shutdown on a job that is mid-write.
  it('settles a job whose runner never observes the abort', async () => {
    const ws = buildWs()
    const release: { fire?: () => void } = {}
    const job = ws.jobTable.submit({
      command: 'long',
      run: deaf(release),
      abort: new AbortController(),
      cwd: '/',
    })
    expect(job.status).toBe(JobStatus.RUNNING)

    await ws.close()

    expect(job.status).toBe(JobStatus.KILLED)
    expect(job.exitCode).toBe(137)
    await job.console.waitFinished()

    // The runner unwinding afterwards must not reopen or relabel it.
    release.fire?.()
    await Promise.resolve()
    expect(job.status).toBe(JobStatus.KILLED)
  })

  it('is idempotent with a job running', async () => {
    const ws = buildWs()
    const release: { fire?: () => void } = {}
    const job = ws.jobTable.submit({
      command: 'long',
      run: deaf(release),
      abort: new AbortController(),
      cwd: '/',
    })

    await ws.close()
    await ws.close()

    expect(job.status).toBe(JobStatus.KILLED)
    release.fire?.()
  })
})
