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
import { PythonRuntime } from './base.ts'
import type { RunArgs, RunResult } from '../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'

class ProcessRuntime extends PythonRuntime {
  readonly name = 'custom-process'
  runs = 0

  run(_args: RunArgs): Promise<RunResult> {
    this.runs += 1
    return Promise.resolve({
      stdout: new TextEncoder().encode('unexpected execution'),
      stderr: null,
      exitCode: 0,
    })
  }
}

describe('PythonRuntime version defaults', () => {
  it.each([MountMode.READ, MountMode.WRITE, MountMode.EXEC])(
    'never executes custom process code in %s mode',
    async (mode) => {
      const runtime = new ProcessRuntime()
      expect(runtime.reach).toBe('process')
      const ws = new Workspace(
        { '/': new RAMVFS() },
        { mode, runtimes: [runtime, 'workspace'], shellParser: await getTestParser() },
      )
      try {
        for (const line of ['python --version', 'python3 -V', 'python -VV']) {
          const io = await ws.shell(line, { env: { PYTHONPATH: '/startup' } })
          expect(io.exitCode).toBe(1)
          expect(new TextDecoder().decode(io.stdout)).toBe('')
          expect(new TextDecoder().decode(io.stderr)).toBe(
            'custom-process: version information unavailable\n',
          )
          expect(runtime.runs).toBe(0)
        }
      } finally {
        await ws.close()
      }
    },
  )
})
