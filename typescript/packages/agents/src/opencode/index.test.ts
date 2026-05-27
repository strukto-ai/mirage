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
import { OpsRegistry, RAMResource, MountMode, Workspace } from '@struktoai/mirage-node'
import { mirageTools, miragePlugin } from './index.ts'

function mkWs(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

interface ToolResultObj {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

async function callTool(t: unknown, input: unknown): Promise<ToolResultObj> {
  const exec = (t as { execute?: (input: unknown, ctx: unknown) => unknown }).execute
  if (typeof exec !== 'function') throw new Error('tool has no execute')
  const ctx = {
    sessionID: 's',
    messageID: 'm',
    agent: 'a',
    directory: '/',
    worktree: '/',
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: () => Promise.resolve(),
  }
  const result = await exec(input, ctx)
  return result as ToolResultObj
}

describe('opencode mirageTools.read', () => {
  it('reads a text file', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/notes.txt', 'hello')
    const r = await callTool(mirageTools(ws).read, { filePath: '/notes.txt' })
    expect(r.output).toBe('hello')
    expect(r.title).toBe('/notes.txt')
  })

  it('returns error message for missing file', async () => {
    const r = await callTool(mirageTools(mkWs()).read, { filePath: '/missing.txt' })
    expect(r.output.startsWith('Error:')).toBe(true)
  })

  it('returns binary stub for non-text files', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/blob.bin', new Uint8Array([0, 1, 2, 3]))
    const r = await callTool(mirageTools(ws).read, { filePath: '/blob.bin' })
    expect(r.output).toContain('Binary file')
    expect(r.metadata?.binary).toBe(true)
  })
})

describe('opencode mirageTools.write', () => {
  it('writes a new file', async () => {
    const ws = mkWs()
    const r = await callTool(mirageTools(ws).write, { filePath: '/out.txt', content: 'data' })
    expect(r.title).toBe('/out.txt')
    expect(await ws.fs.readFileText('/out.txt')).toBe('data')
  })

  it('creates missing parent directories', async () => {
    const ws = mkWs()
    await callTool(mirageTools(ws).write, { filePath: '/a/b/c.txt', content: 'x' })
    expect(await ws.fs.readFileText('/a/b/c.txt')).toBe('x')
  })
})

describe('opencode mirageTools.edit', () => {
  it('replaces single occurrence', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'foo bar baz')
    const r = await callTool(mirageTools(ws).edit, {
      filePath: '/f.txt',
      oldString: 'bar',
      newString: 'BAR',
    })
    expect(r.metadata?.occurrences).toBe(1)
    expect(await ws.fs.readFileText('/f.txt')).toBe('foo BAR baz')
  })

  it('rejects multiple occurrences without replaceAll', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'aa aa')
    const r = await callTool(mirageTools(ws).edit, {
      filePath: '/f.txt',
      oldString: 'aa',
      newString: 'X',
    })
    expect(r.output).toContain('appears 2 times')
  })

  it('replaces all when replaceAll is true', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'aa aa')
    const r = await callTool(mirageTools(ws).edit, {
      filePath: '/f.txt',
      oldString: 'aa',
      newString: 'X',
      replaceAll: true,
    })
    expect(r.metadata?.occurrences).toBe(2)
    expect(await ws.fs.readFileText('/f.txt')).toBe('X X')
  })

  it('returns error when string not found', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'hello')
    const r = await callTool(mirageTools(ws).edit, {
      filePath: '/f.txt',
      oldString: 'world',
      newString: 'X',
    })
    expect(r.output).toContain('string not found')
  })
})

describe('opencode mirageTools.ls', () => {
  it('lists entries with trailing slash for dirs', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/a.txt', 'a')
    await ws.fs.mkdir('/d')
    const r = await callTool(mirageTools(ws).ls, { path: '/' })
    const entries = r.output.split('\n').sort()
    expect(entries).toContain('/a.txt')
    expect(entries).toContain('/d/')
  })
})

describe('opencode mirageTools.bash', () => {
  it('runs a shell command and returns stdout', async () => {
    const r = await callTool(mirageTools(mkWs()).bash, { command: 'echo hello' })
    expect(r.output).toBe('hello')
    expect(r.metadata?.exitCode).toBe(0)
  })

  it('captures non-zero exit code', async () => {
    const r = await callTool(mirageTools(mkWs()).bash, { command: 'cat /nope.txt' })
    expect(r.metadata?.exitCode).not.toBe(0)
  })
})

describe('opencode mirageTools.glob', () => {
  it('finds files matching a name pattern', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/a.ts', '')
    await ws.fs.writeFile('/b.ts', '')
    await ws.fs.writeFile('/c.md', '')
    const r = await callTool(mirageTools(ws).glob, { pattern: '*.ts' })
    expect(r.output).toContain('/a.ts')
    expect(r.output).toContain('/b.ts')
    expect(r.output).not.toContain('/c.md')
  })
})

describe('opencode mirageTools.grep', () => {
  it('finds text matches across files', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/a.txt', 'hello world')
    await ws.fs.writeFile('/b.txt', 'goodbye')
    const r = await callTool(mirageTools(ws).grep, { pattern: 'hello' })
    expect(r.output).toContain('/a.txt')
    expect(r.output).toContain('hello')
  })
})

describe('opencode miragePlugin', () => {
  it('returns a plugin that registers tools', async () => {
    const ws = mkWs()
    const plugin = miragePlugin(ws)
    const hooks = await plugin({})
    expect(hooks.tool).toBeDefined()
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      'bash',
      'edit',
      'glob',
      'grep',
      'ls',
      'read',
      'write',
    ])
  })
})
