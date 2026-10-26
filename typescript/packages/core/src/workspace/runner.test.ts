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
import { MountMode } from '../types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Workspace } from './workspace/workspace.ts'
import { WorkspaceRunner } from './runner.ts'

function makeWs(): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.WRITE,
    },
  )
}

describe('WorkspaceRunner', () => {
  it('exposes the workspace and awaits supplied promises', async () => {
    const runner = new WorkspaceRunner(makeWs())
    try {
      expect(runner.ws).toBeDefined()
      const r = await runner.call(runner.ws.shell('echo hello'))
      expect(r.exitCode).toBe(0)
      const text = new TextDecoder().decode(r.stdout).trim()
      expect(text).toBe('hello')
    } finally {
      await runner.stop()
    }
  })

  it('rejects call() after stop()', async () => {
    const runner = new WorkspaceRunner(makeWs())
    await runner.stop()
    await expect(runner.call(Promise.resolve(1))).rejects.toThrow('stopped')
  })

  it('stop() is idempotent', async () => {
    const runner = new WorkspaceRunner(makeWs())
    await runner.stop()
    await runner.stop()
    await runner.stop()
  })
})
