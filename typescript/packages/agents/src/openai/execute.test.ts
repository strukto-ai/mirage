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

import { RunContext } from '@openai/agents'
import { MountMode, OpsRegistry, RAMResource, Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { mirageExecuteTool } from './execute.ts'

function mkWs(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

async function invokeExecute(ws: Workspace, command: string): Promise<string> {
  const execute = mirageExecuteTool(ws)
  const output = await execute.invoke(new RunContext(), JSON.stringify({ command }))
  return output
}

describe('mirageExecuteTool', () => {
  it('returns stdout and the exit code', async () => {
    const output = await invokeExecute(mkWs(), 'echo hello')
    expect(output).toContain('exit code: 0')
    expect(output).toContain('stdout:\nhello\n')
  })

  it('can mutate the workspace', async () => {
    const ws = mkWs()
    await invokeExecute(ws, "printf 'hello' > /hello.txt")
    await expect(ws.fs.readFileText('/hello.txt')).resolves.toBe('hello')
  })

  it('returns stderr and a nonzero exit code', async () => {
    const output = await invokeExecute(mkWs(), 'cat /missing.txt')
    expect(output).toContain('stderr:')
    expect(output).not.toContain('exit code: 0')
  })
})
