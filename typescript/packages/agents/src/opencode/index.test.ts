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
import type { ToolResult } from '@opencode-ai/plugin'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { mirageTools, miragePlugin } from './index.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE })
}

async function callTool(t: unknown, input: unknown): Promise<ToolResult> {
  const exec = (t as { execute?: (input: unknown, ctx: unknown) => unknown }).execute
  if (typeof exec !== 'function') throw new Error('tool has no execute')
  const ctx = {
    sessionID: 's',
    messageID: 'm',
    agent: 'a',
    abort: new AbortController().signal,
  }
  const result = await exec(input, ctx)
  return result as ToolResult
}

describe('opencode mirageTools.read', () => {
  it('reads a text file', async () => {
    const ws = mkWs()
    await ws.vfs.write('/notes.txt', 'hello')
    const out = await callTool(mirageTools(ws).read, { filePath: '/notes.txt' })
    expect(out).toBe('hello')
  })

  it('returns error message for missing file', async () => {
    const out = await callTool(mirageTools(mkWs()).read, { filePath: '/missing.txt' })
    expect(out).toMatch(/^Error:/)
  })

  it('returns binary stub for non-text files', async () => {
    const ws = mkWs()
    await ws.vfs.write('/blob.bin', new Uint8Array([0, 1, 2, 3]))
    const out = await callTool(mirageTools(ws).read, { filePath: '/blob.bin' })
    expect(out).toContain('Binary file')
  })

  it('attaches PDFs for multimodal models', async () => {
    const ws = mkWs()
    await ws.vfs.write('/paper.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    const out = await callTool(mirageTools(ws).read, { filePath: '/paper.pdf' })
    expect(out).toMatchObject({
      attachments: [
        {
          type: 'file',
          mime: 'application/pdf',
          filename: 'paper.pdf',
        },
      ],
    })
  })
})

describe('opencode mirageTools.write', () => {
  it('writes a new file', async () => {
    const ws = mkWs()
    const out = await callTool(mirageTools(ws).write, { filePath: '/out.txt', content: 'data' })
    expect(out).toContain('/out.txt')
    expect(await ws.vfs.cat('/out.txt')).toBe('data')
  })

  it('creates missing parent directories', async () => {
    const ws = mkWs()
    await callTool(mirageTools(ws).write, { filePath: '/a/b/c.txt', content: 'x' })
    expect(await ws.vfs.cat('/a/b/c.txt')).toBe('x')
  })

  it('rejects an overwrite after the file changed since the session read it', async () => {
    const ws = mkWs()
    await ws.vfs.write('/out.txt', 'original')
    const tools = mirageTools(ws)
    await callTool(tools.read, { filePath: '/out.txt' })
    await ws.vfs.write('/out.txt', 'changed elsewhere')

    const out = await callTool(tools.write, { filePath: '/out.txt', content: 'replacement' })

    expect(out).toContain('File changed since it was last read')
    expect(await ws.vfs.cat('/out.txt')).toBe('changed elsewhere')
  })

  it('can disable stale write protection', async () => {
    const ws = mkWs()
    await ws.vfs.write('/out.txt', 'original')
    const tools = mirageTools(ws, { staleWriteProtection: false })
    await callTool(tools.read, { filePath: '/out.txt' })
    await ws.vfs.write('/out.txt', 'changed elsewhere')

    await callTool(tools.write, { filePath: '/out.txt', content: 'replacement' })

    expect(await ws.vfs.cat('/out.txt')).toBe('replacement')
  })
})

describe('opencode mirageTools.edit', () => {
  it('replaces single occurrence', async () => {
    const ws = mkWs()
    await ws.vfs.write('/f.txt', 'foo bar baz')
    const out = await callTool(mirageTools(ws).edit, {
      filePath: '/f.txt',
      oldString: 'bar',
      newString: 'BAR',
    })
    expect(out).toContain('1 occurrence')
    expect(await ws.vfs.cat('/f.txt')).toBe('foo BAR baz')
  })

  it('rejects multiple occurrences without replaceAll', async () => {
    const ws = mkWs()
    await ws.vfs.write('/f.txt', 'aa aa')
    const out = await callTool(mirageTools(ws).edit, {
      filePath: '/f.txt',
      oldString: 'aa',
      newString: 'X',
    })
    expect(out).toContain('appears 2 times')
  })

  it('replaces all when replaceAll is true', async () => {
    const ws = mkWs()
    await ws.vfs.write('/f.txt', 'aa aa')
    const out = await callTool(mirageTools(ws).edit, {
      filePath: '/f.txt',
      oldString: 'aa',
      newString: 'X',
      replaceAll: true,
    })
    expect(out).toContain('2 occurrences')
    expect(await ws.vfs.cat('/f.txt')).toBe('X X')
  })

  it('returns error when string not found', async () => {
    const ws = mkWs()
    await ws.vfs.write('/f.txt', 'hello')
    const out = await callTool(mirageTools(ws).edit, {
      filePath: '/f.txt',
      oldString: 'world',
      newString: 'X',
    })
    expect(out).toContain('string not found')
  })

  it('rejects an edit after the file changed since the session read it', async () => {
    const ws = mkWs()
    await ws.vfs.write('/f.txt', 'original')
    const tools = mirageTools(ws)
    await callTool(tools.read, { filePath: '/f.txt' })
    await ws.vfs.write('/f.txt', 'changed elsewhere')

    const out = await callTool(tools.edit, {
      filePath: '/f.txt',
      oldString: 'changed',
      newString: 'updated',
    })

    expect(out).toContain('File changed since it was last read')
    expect(await ws.vfs.cat('/f.txt')).toBe('changed elsewhere')
  })
})

describe('opencode mirageTools.ls', () => {
  it('lists entries with trailing slash for dirs', async () => {
    const ws = mkWs()
    await ws.vfs.write('/a.txt', 'a')
    await ws.vfs.mkdir('/d')
    const out = await callTool(mirageTools(ws).ls, { path: '/' })
    if (typeof out !== 'string') throw new Error('expected text output')
    const entries = out.split('\n').sort()
    expect(entries).toContain('/a.txt')
    expect(entries).toContain('/d/')
  })
})

describe('opencode mirageTools.bash', () => {
  it('runs a shell command and returns stdout', async () => {
    const out = await callTool(mirageTools(mkWs()).bash, { command: 'echo hello' })
    expect(out).toBe('hello')
  })

  it('captures stderr on failure', async () => {
    const out = await callTool(mirageTools(mkWs()).bash, { command: 'cat /nope.txt' })
    if (typeof out !== 'string') throw new Error('expected text output')
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('opencode mirageTools.glob', () => {
  it('finds files matching a name pattern', async () => {
    const ws = mkWs()
    await ws.vfs.write('/a.ts', '')
    await ws.vfs.write('/b.ts', '')
    await ws.vfs.write('/c.md', '')
    const out = await callTool(mirageTools(ws).glob, { pattern: '*.ts' })
    expect(out).toContain('/a.ts')
    expect(out).toContain('/b.ts')
    expect(out).not.toContain('/c.md')
  })
})

describe('opencode mirageTools.grep', () => {
  it('finds text matches across files', async () => {
    const ws = mkWs()
    await ws.vfs.write('/a.txt', 'hello world')
    await ws.vfs.write('/b.txt', 'goodbye')
    const out = await callTool(mirageTools(ws).grep, { pattern: 'hello' })
    expect(out).toContain('/a.txt')
    expect(out).toContain('hello')
  })
})

describe('opencode miragePlugin', () => {
  it('returns a plugin that registers tools', async () => {
    const ws = mkWs()
    const plugin = miragePlugin(ws)
    const hooks = await (plugin as unknown as (input: unknown) => ReturnType<typeof plugin>)({})
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

describe('opencode resolver (per-session workspace)', () => {
  it('routes each session to its own workspace', async () => {
    const wsA = mkWs()
    const wsB = mkWs()
    await wsA.vfs.write('/note.txt', 'alice')
    await wsB.vfs.write('/note.txt', 'bob')
    const tools = mirageTools((ctx) => (ctx.sessionID === 'a' ? wsA : wsB))

    const exec = (t: unknown) =>
      (t as { execute: (a: unknown, c: unknown) => Promise<string> }).execute
    const ctxA = { sessionID: 'a', messageID: 'm', agent: '', abort: new AbortController().signal }
    const ctxB = { sessionID: 'b', messageID: 'm', agent: '', abort: new AbortController().signal }

    expect(await exec(tools.read)({ filePath: '/note.txt' }, ctxA)).toBe('alice')
    expect(await exec(tools.read)({ filePath: '/note.txt' }, ctxB)).toBe('bob')
  })

  it('keeps stale-read state isolated between sessions sharing a workspace', async () => {
    const ws = mkWs()
    await ws.vfs.write('/note.txt', 'one')
    const tools = mirageTools(ws)
    const exec = (t: unknown) =>
      (t as { execute: (a: unknown, c: unknown) => Promise<string> }).execute
    const ctxA = { sessionID: 'a', messageID: 'm', agent: '', abort: new AbortController().signal }
    const ctxB = { sessionID: 'b', messageID: 'm', agent: '', abort: new AbortController().signal }

    await exec(tools.read)({ filePath: '/note.txt' }, ctxA)
    await exec(tools.write)({ filePath: '/note.txt', content: 'two' }, ctxB)
    const out = await exec(tools.write)({ filePath: '/note.txt', content: 'three' }, ctxA)

    expect(out).toContain('File changed since it was last read')
    expect(await ws.vfs.cat('/note.txt')).toBe('two')
  })
})

async function guardedWs(): Promise<Workspace> {
  const ws = new Workspace(
    { '/': new RAMVFS(), '/vault': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      profiles: { guarded: parseSessionProfile({ paths: { hide: ['/vault'] } }) },
    },
  )
  await ws.shell('echo key > /vault/key.txt')
  ws.createSession('agent', { profile: 'guarded' })
  return ws
}

describe('opencode mirageTools sessionId', () => {
  it('acts as the session, under its profile', async () => {
    const ws = await guardedWs()
    const tools = mirageTools(ws, { sessionId: 'agent' })
    const read = await callTool(tools.read, { filePath: '/vault/key.txt' })
    const listed = await callTool(tools.ls, { path: '/' })
    const ran = await callTool(tools.bash, { command: 'cat /vault/key.txt' })
    expect(read).toEqual(expect.stringMatching(/^Error: /))
    expect(listed).not.toEqual(expect.stringContaining('vault'))
    expect(ran).toEqual(expect.stringContaining('No such file or directory'))
    await ws.close()
  })
})
