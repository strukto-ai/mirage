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
import { stdoutStr } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace.ts'
import { JobKey, StateKey } from './keys.ts'
import { toStateDict } from './state.ts'

describe('toStateDict', () => {
  // A snapshot keeps the finished lines and processes, with each finished
  // job's line, and a workspace loaded from it lists them under its own id,
  // numbering new processes past them.
  it('keeps the finished lines and processes', async () => {
    const src = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    let restored: Workspace | null = null
    try {
      await src.shell('true &')
      await src.jobTable.wait(1, src.defaultSessionId)
      const state = await toStateDict(src)
      const [line] = state[StateKey.LINES] ?? []
      expect([line?.command, line?.state]).toEqual(['true &', 'exited'])
      const [job] = state[StateKey.JOBS]
      expect(job?.[JobKey.LINE]).toBe(line?.id)
      const saved = (state[StateKey.PROCESS_RECORDS] ?? [])
        .map((p) => Number(String(p.id).split(':').at(-1)))
        .sort((a, b) => a - b)
      expect(saved.length).toBeGreaterThan(0)
      restored = await Workspace.fromState(state)
      const [kept] = await restored.lines()
      expect([kept?.id.value, kept?.command]).toEqual([line?.id, 'true &'])
      const processes = await restored.processes()
      expect(processes.map((p) => p.id.pid)).toEqual(saved)
      expect(new Set(processes.map((p) => p.id.workspaceId))).toEqual(
        new Set([restored.workspaceId]),
      )
      const [restoredJob] = await restored.jobs()
      expect(restoredJob?.line?.value).toBe(kept?.id.value)
      const pid = Number(stdoutStr(await restored.shell('true & echo $!')))
      expect(pid).toBeGreaterThan(saved.at(-1) ?? 0)
    } finally {
      await src.close()
      await restored?.close()
    }
  })
})
