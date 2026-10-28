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
import { Channel, JobConsole } from '../../shell/console/index.ts'
import type * as Constants from '../../shell/job_table/constants.ts'
import { Limit, MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace.ts'

vi.mock('../../shell/job_table/constants.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof Constants>()),
  STOP_WAIT_SECONDS: 0.2,
}))

class Held extends JobConsole {
  override emit(): Promise<void> {
    return new Promise(() => undefined)
  }
}

const DEC = new TextDecoder()

describe('a job past its limit', () => {
  it('ends while a reader holds its output', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, commandLimits: { '@line': new Limit({ timeoutSeconds: 0.2 }) } },
    )
    try {
      Object.assign(ws.sessionManager.get(ws.defaultSessionId).tty, { jobs: new Held() })
      await ws.shell('seq 1 1000000000 &')
      const job = await ws.jobTable.wait(1, ws.defaultSessionId)
      expect(job.exitCode).toBe(124)
      expect(DEC.decode(await job.console.snapshot(Channel.STDERR))).toBe(
        'line: timed out after 0.2s\n',
      )
    } finally {
      await ws.close()
    }
  }, 10_000)
})
