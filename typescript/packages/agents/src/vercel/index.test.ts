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
import { mirageTools } from './index.ts'

function mkWs(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

async function callTool<T>(t: unknown, input: unknown): Promise<T> {
  const exec = (t as { execute?: (input: unknown, opts: unknown) => unknown }).execute
  if (typeof exec !== 'function') throw new Error('tool has no execute')
  const result = await exec(input, { toolCallId: 't', messages: [] })
  return result as T
}

describe('vercel mirageTools.execute', () => {
  it('runs a shell command and returns stdout/stderr/exitCode', async () => {
    const tools = mirageTools(mkWs())
    const r = await callTool<{ stdout: string; stderr: string; exitCode: number }>(tools.execute, {
      command: 'echo hello',
    })
    expect(r.stdout).toBe('hello\n')
    expect(r.stderr).toBe('')
    expect(r.exitCode).toBe(0)
  })

  it('captures non-zero exit code', async () => {
    const tools = mirageTools(mkWs())
    const r = await callTool<{ stdout: string; stderr: string; exitCode: number }>(tools.execute, {
      command: 'cat /nope.txt',
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.length).toBeGreaterThan(0)
  })
})

describe('vercel mirageTools.readFile', () => {
  it('reads file content as text', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/notes.txt', 'hello')
    const r = await callTool<{ kind: string; content: string; mimeType: string }>(
      mirageTools(ws).readFile,
      { path: '/notes.txt' },
    )
    expect(r.kind).toBe('text')
    expect(r.content).toBe('hello')
    expect(r.mimeType).toBe('text/plain')
  })

  it('returns error for missing file', async () => {
    const r = await callTool<{ error: string }>(mirageTools(mkWs()).readFile, {
      path: '/missing.txt',
    })
    expect(r.error).toBeDefined()
    expect(r.error.length).toBeGreaterThan(0)
  })

  it('returns base64 + mime for image files', async () => {
    const ws = mkWs()
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
    await ws.fs.writeFile('/photo.png', png)
    const r = await callTool<{
      kind: string
      mimeType: string
      base64: string
      bytes: number
    }>(mirageTools(ws).readFile, { path: '/photo.png' })
    expect(r.kind).toBe('media')
    expect(r.mimeType).toBe('image/png')
    expect(r.bytes).toBe(16)
    expect(r.base64.length).toBeGreaterThan(0)
    expect(Buffer.from(r.base64, 'base64')).toEqual(Buffer.from(png))
  })

  it('returns base64 + mime for PDFs', async () => {
    const ws = mkWs()
    const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF\n')
    await ws.fs.writeFile('/doc.pdf', pdf)
    const r = await callTool<{ kind: string; mimeType: string; base64: string }>(
      mirageTools(ws).readFile,
      { path: '/doc.pdf' },
    )
    expect(r.kind).toBe('media')
    expect(r.mimeType).toBe('application/pdf')
    expect(Buffer.from(r.base64, 'base64').toString('utf-8')).toBe('%PDF-1.4\n%%EOF\n')
  })

  it('returns binary stub for unsupported binary mimes', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/blob.bin', new Uint8Array([0, 1, 2, 3]))
    const r = await callTool<{ kind: string; mimeType: string; note: string }>(
      mirageTools(ws).readFile,
      { path: '/blob.bin' },
    )
    expect(r.kind).toBe('binary')
    expect(r.mimeType).toBe('application/octet-stream')
    expect(r.note).toContain('Use the execute tool')
  })
})

describe('vercel mirageTools.readFile.toModelOutput', () => {
  function callToModelOutput(t: unknown, output: unknown): unknown {
    const fn = (t as { toModelOutput?: (opts: unknown) => unknown }).toModelOutput
    if (typeof fn !== 'function') throw new Error('tool has no toModelOutput')
    return fn({ toolCallId: 't', input: {}, output })
  }

  it('text → {type:"text", value}', () => {
    const out = callToModelOutput(mirageTools(mkWs()).readFile, {
      kind: 'text',
      path: '/x.txt',
      mimeType: 'text/plain',
      content: 'hello',
      bytes: 5,
    })
    expect(out).toEqual({ type: 'text', value: 'hello' })
  })

  it('media → {type:"content", value:[text, file]}', () => {
    const out = callToModelOutput(mirageTools(mkWs()).readFile, {
      kind: 'media',
      path: '/p.png',
      mimeType: 'image/png',
      base64: 'AAAA',
      bytes: 3,
    }) as {
      type: string
      value: {
        type: string
        text?: string
        data?: { type: string; data: string }
        mediaType?: string
      }[]
    }
    expect(out.type).toBe('content')
    expect(out.value).toHaveLength(2)
    expect(out.value[0]).toEqual({ type: 'text', text: '[/p.png] image/png (3 bytes)' })
    expect(out.value[1]).toEqual({
      type: 'file',
      data: { type: 'data', data: 'AAAA' },
      mediaType: 'image/png',
    })
  })

  it('binary → text stub', () => {
    const out = callToModelOutput(mirageTools(mkWs()).readFile, {
      kind: 'binary',
      path: '/x.bin',
      mimeType: 'application/octet-stream',
      bytes: 4,
      note: 'Binary file /x.bin (application/octet-stream, 4 bytes). Use the execute tool',
    }) as { type: string; value: string }
    expect(out.type).toBe('text')
    expect(out.value).toContain('Use the execute tool')
  })

  it('error → {type:"error-text"}', () => {
    const out = callToModelOutput(mirageTools(mkWs()).readFile, { error: 'ENOENT' })
    expect(out).toEqual({ type: 'error-text', value: 'ENOENT' })
  })
})

describe('vercel mirageTools.writeFile', () => {
  it('creates a new file with content', async () => {
    const ws = mkWs()
    const r = await callTool<{ path: string }>(mirageTools(ws).writeFile, {
      path: '/out.txt',
      content: 'data',
    })
    expect(r.path).toBe('/out.txt')
    expect(await ws.fs.readFileText('/out.txt')).toBe('data')
  })

  it('mkdirs missing parent directories', async () => {
    const ws = mkWs()
    const r = await callTool<{ path: string }>(mirageTools(ws).writeFile, {
      path: '/a/b/c.txt',
      content: 'x',
    })
    expect(r.path).toBe('/a/b/c.txt')
    expect(await ws.fs.readFileText('/a/b/c.txt')).toBe('x')
  })
})

describe('vercel mirageTools.editFile', () => {
  it('replaces single occurrence', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'foo bar baz')
    const r = await callTool<{ occurrences: number }>(mirageTools(ws).editFile, {
      path: '/f.txt',
      oldString: 'bar',
      newString: 'BAR',
    })
    expect(r.occurrences).toBe(1)
    expect(await ws.fs.readFileText('/f.txt')).toBe('foo BAR baz')
  })

  it('rejects multiple occurrences without replaceAll', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'aa aa')
    const r = await callTool<{ error: string }>(mirageTools(ws).editFile, {
      path: '/f.txt',
      oldString: 'aa',
      newString: 'X',
    })
    expect(r.error).toContain('appears 2 times')
  })

  it('replaces all when replaceAll is true', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'aa aa')
    const r = await callTool<{ occurrences: number }>(mirageTools(ws).editFile, {
      path: '/f.txt',
      oldString: 'aa',
      newString: 'X',
      replaceAll: true,
    })
    expect(r.occurrences).toBe(2)
    expect(await ws.fs.readFileText('/f.txt')).toBe('X X')
  })
})

describe('vercel mirageTools.ls', () => {
  it('lists entries with is_dir flags', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/a.txt', 'a')
    await ws.fs.mkdir('/d')
    const r = await callTool<{ files: { path: string; is_dir: boolean }[] }>(mirageTools(ws).ls, {
      path: '/',
    })
    const paths = r.files.map((f) => f.path).sort()
    expect(paths).toContain('/a.txt')
    expect(paths).toContain('/d')
    expect(r.files.find((f) => f.path === '/d')?.is_dir).toBe(true)
    expect(r.files.find((f) => f.path === '/a.txt')?.is_dir).toBe(false)
  })
})
