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
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { mirageTools } from './tools.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE })
}

async function invoke(
  ws: Workspace,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const found = mirageTools(ws).find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return found.invoke(new RunContext(), JSON.stringify(args))
}

describe('openai mirageTools', () => {
  it('serves the tool table under its names', () => {
    expect(mirageTools(mkWs()).map((t) => t.name)).toEqual([
      'shell',
      'read',
      'write',
      'edit',
      'ls',
      'grep',
      'glob',
    ])
  })

  it('answers as the MCP tools do', async () => {
    const ws = mkWs()
    expect(await invoke(ws, 'write', { path: '/src/a.py', content: 'Needle\n' })).toBe(
      'Written: /src/a.py',
    )
    expect(await invoke(ws, 'read', { path: '/src/a.py' })).toBe('     1\tNeedle\n')
    await invoke(ws, 'edit', { path: '/src/a.py', old_string: 'Needle', new_string: 'pin' })
    expect(await invoke(ws, 'ls', { path: '/src' })).toBe('a.py\n')
    expect(await invoke(ws, 'grep', { pattern: 'PIN', path: '/src', ignore_case: true })).toBe(
      '/src/a.py:1:pin\n',
    )
    expect(await invoke(ws, 'glob', { pattern: '**/*.py' })).toBe('/src/a.py\n')
    expect(await invoke(ws, 'shell', { command: 'echo hello' })).toBe('hello\n')
  })

  it('hands an image to the model as input it can see', async () => {
    const ws = mkWs()
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
    await ws.vfs.write('/photo.png', png)
    const out = (await invoke(ws, 'read', { path: '/photo.png' })) as {
      type: string
      image: { mediaType: string }
    }
    expect(out.type).toBe('image')
    expect(out.image.mediaType).toBe('image/png')
  })

  it('sniffs a PDF whose name has no extension', async () => {
    const ws = mkWs()
    await ws.vfs.write('/document', new TextEncoder().encode('%PDF-1.4\n%%EOF\n'))
    const out = (await invoke(ws, 'read', { path: '/document' })) as {
      type: string
      file: { mediaType: string; filename: string }
    }
    expect(out.type).toBe('file')
    expect(out.file).toMatchObject({ mediaType: 'application/pdf', filename: 'document' })
  })
})
