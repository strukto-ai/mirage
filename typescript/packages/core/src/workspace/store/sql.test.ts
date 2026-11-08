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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fileDriver } from '../../../tests/workspace/fixtures/sqlite_driver.ts'
import { stdoutStr } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace.ts'
import { SqlWorkspaceStateStore } from './sql.ts'

// Two daemons on one database share a workspace's execution plane: the one
// that does not hold the lease lists the lines, jobs and processes the holder
// runs, once the holder has written them a moment after the line returns, and
// kills its job; a workspace opened on the database later lists the lines that
// ended.
it('keeps the execution plane in the database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-state-'))
  const open = (): Workspace =>
    new Workspace(
      { '/m': [new RAMVFS(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        workspaceId: 'shared',
        sessionId: 's',
        store: new SqlWorkspaceStateStore(fileDriver(join(dir, 'state.db')), {
          ownsDriver: true,
        }),
        ownsStore: true,
      },
    )
  try {
    const a = open()
    const b = open()
    try {
      const pid = Number(stdoutStr(await a.shell('sleep 30 & echo $!', { sessionId: 's' })))
      await vi.waitFor(async () => {
        const lines = (await b.lines()).map((line) => [line.command, line.state])
        expect(lines).toEqual([['sleep 30 & echo $!', 'exited']])
      })
      const [running] = await b.processes({ state: 'running' })
      expect(running?.id.pid).toBe(pid)
      const [job] = await b.jobs()
      expect([job?.command, job?.state]).toEqual(['sleep 30', 'running'])
      expect(await b.jobTable.kill(1, 's', 15)).toBe(true)
      expect((await b.jobTable.wait(1, 's')).exitCode).toBe(143)
    } finally {
      await a.close()
      await b.close()
    }
    const later = open()
    try {
      expect((await later.lines()).map((l) => l.command)).toEqual(['sleep 30 & echo $!'])
    } finally {
      await later.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
