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
import { OpsRegistry } from '@struktoai/mirage-core/ops/registry'
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import type { WorkspaceOptions } from '@struktoai/mirage-core/workspace/workspace/types'
import { Workspace } from '@struktoai/mirage-node'
import { MirageShell } from './shell.ts'

function mkWs(extra: Partial<WorkspaceOptions> = {}): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops, ...extra })
}

describe('MirageShell', () => {
  it('runs a single command and returns structured output', async () => {
    const ws = mkWs()
    const shell = new MirageShell(ws)
    const result = await shell.run({ commands: ['echo hello'] })

    expect(result.output).toHaveLength(1)
    const [first] = result.output
    if (first === undefined) throw new Error('expected one result entry')
    expect(first.stdout).toBe('hello\n')
    expect(first.stderr).toBe('')
    expect(first.outcome).toEqual({ type: 'exit', exitCode: 0 })
  })

  it('runs multiple commands in order, one entry each', async () => {
    const ws = mkWs()
    const shell = new MirageShell(ws)
    const result = await shell.run({
      commands: ['echo first', 'echo second'],
    })

    expect(result.output.map((o) => o.stdout)).toEqual(['first\n', 'second\n'])
  })

  it('captures stderr and exitCode for failing commands', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/exists.txt', 'x')
    const shell = new MirageShell(ws)
    const result = await shell.run({ commands: ['cat /missing-file.txt'] })

    const [out] = result.output
    if (out === undefined) throw new Error('expected one result entry')
    expect(out.stderr.length).toBeGreaterThan(0)
    expect(out.outcome.type).toBe('exit')
    if (out.outcome.type === 'exit') {
      expect(out.outcome.exitCode).not.toBe(0)
    }
  })

  it('names the reason beside a refused command', async () => {
    // stderr is bash's bare `Permission denied`; the reason rides the
    // refusal record, and a text surface appends it as one more line.
    const ws = mkWs({
      routePolicy: (ctx) => (ctx.command === 'rm' ? { deny: 'no deletes' } : null),
    })
    const shell = new MirageShell(ws)
    const result = await shell.run({ commands: ['rm /x'] })

    const [out] = result.output
    if (out === undefined) throw new Error('expected one result entry')
    expect(out.stderr).toBe('rm: Permission denied\npolicy denied: no deletes\n')
    expect(out.outcome).toEqual({ type: 'exit', exitCode: 126 })
  })
})
