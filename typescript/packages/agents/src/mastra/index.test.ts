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
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { mirageTools } from './index.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE })
}

interface Answer {
  text: string
  isError: boolean
}

async function runTool(t: unknown, input: unknown): Promise<Answer> {
  const exec = (t as { execute?: (input: unknown, ctx: unknown) => unknown }).execute
  if (typeof exec !== 'function') throw new Error('tool has no execute')
  return (await exec(input, {})) as Answer
}

describe('mastra mirageTools', () => {
  it('serves the tool table under its names', () => {
    const tools = mirageTools(mkWs())
    expect(Object.keys(tools).sort()).toEqual(
      ['edit', 'glob', 'grep', 'ls', 'read', 'shell', 'write'].sort(),
    )
    expect(tools.shell?.id).toBe('mirage-shell')
  })

  it('answers as the MCP tools do', async () => {
    const tools = mirageTools(mkWs())
    const written = await runTool(tools.write, { path: '/src/a.py', content: 'Needle\n' })
    const read = await runTool(tools.read, { path: '/src/a.py' })
    const edited = await runTool(tools.edit, {
      path: '/src/a.py',
      old_string: 'Needle',
      new_string: 'pin',
    })
    const listed = await runTool(tools.ls, { path: '/src' })
    const found = await runTool(tools.grep, { pattern: 'PIN', path: '/src', ignore_case: true })
    const globbed = await runTool(tools.glob, { pattern: '**/*.py' })
    const shell = await runTool(tools.shell, { command: 'cat /nope.txt' })
    expect(written).toEqual({ text: 'Written: /src/a.py', isError: false })
    expect(read).toEqual({ text: '     1\tNeedle\n', isError: false })
    expect(edited.isError).toBe(false)
    expect(listed).toEqual({ text: 'a.py\n', isError: false })
    expect(found).toEqual({ text: '/src/a.py:1:pin\n', isError: false })
    expect(globbed).toEqual({ text: '/src/a.py\n', isError: false })
    expect(shell.isError).toBe(true)
  })
})
