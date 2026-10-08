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

import { describe, expect, it, vi } from 'vitest'
import { Files } from '@struktoai/mirage-core/workspace/files'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { mirageTools } from './index.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE })
}

async function callTool<T>(t: unknown, input: unknown): Promise<T> {
  const exec = (t as { execute?: (input: unknown, opts: unknown) => unknown }).execute
  if (typeof exec !== 'function') throw new Error('tool has no execute')
  const result = await exec(input, { toolCallId: 't', messages: [] })
  return result as T
}

function callToModelOutput(t: unknown, output: unknown): unknown {
  const fn = (t as { toModelOutput?: (opts: unknown) => unknown }).toModelOutput
  if (typeof fn !== 'function') throw new Error('tool has no toModelOutput')
  return fn({ toolCallId: 't', input: {}, output })
}

interface Answer {
  text: string
  isError: boolean
}

describe('vercel mirageTools', () => {
  it('serves the tool table under its names', () => {
    expect(Object.keys(mirageTools(mkWs())).sort()).toEqual(
      ['edit', 'glob', 'grep', 'ls', 'read', 'shell', 'write'].sort(),
    )
  })

  it('answers as the MCP tools do', async () => {
    const tools = mirageTools(mkWs())
    const written = await callTool<Answer>(tools.write, { path: '/src/a.py', content: 'Needle\n' })
    const read = await callTool<Answer>(tools.read, { path: '/src/a.py' })
    const edited = await callTool<Answer>(tools.edit, {
      path: '/src/a.py',
      old_string: 'Needle',
      new_string: 'pin',
    })
    const listed = await callTool<Answer>(tools.ls, { path: '/src' })
    const found = await callTool<Answer>(tools.grep, {
      pattern: 'PIN',
      path: '/src',
      ignore_case: true,
    })
    const globbed = await callTool<Answer>(tools.glob, { pattern: '**/*.py' })
    const shell = await callTool<Answer>(tools.shell, { command: 'cat /nope.txt' })
    const missing = await callTool<Answer>(tools.read, { path: '/nope.txt' })
    expect(written).toEqual({ text: 'Written: /src/a.py', isError: false })
    expect(read).toEqual({ text: '     1\tNeedle\n', isError: false })
    expect(edited.isError).toBe(false)
    expect(listed).toEqual({ text: 'a.py\n', isError: false })
    expect(found).toEqual({ text: '/src/a.py:1:pin\n', isError: false })
    expect(globbed).toEqual({ text: '/src/a.py\n', isError: false })
    expect(shell.isError).toBe(true)
    expect(missing).toEqual({ text: "Error: file '/nope.txt' not found", isError: true })
  })
})

describe('vercel mirageTools.read media', () => {
  it('hands an image to the model as a file', async () => {
    const ws = mkWs()
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
    await ws.vfs.write('/photo.png', png)
    const r = await callTool<{ kind: string; mimeType: string; base64: string }>(
      mirageTools(ws).read,
      { path: '/photo.png' },
    )
    expect(r.kind).toBe('media')
    expect(r.mimeType).toBe('image/png')
    expect(Buffer.from(r.base64, 'base64')).toEqual(Buffer.from(png))
  })

  it('hands a PDF to the model as a file', async () => {
    const ws = mkWs()
    await ws.vfs.write('/doc.pdf', new TextEncoder().encode('%PDF-1.4\n%%EOF\n'))
    const r = await callTool<{ kind: string; mimeType: string }>(mirageTools(ws).read, {
      path: '/doc.pdf',
    })
    expect(r.kind).toBe('media')
    expect(r.mimeType).toBe('application/pdf')
  })

  it('sniffs an image whose name has no extension', async () => {
    const ws = mkWs()
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
    await ws.vfs.mkdir('/archive')
    await ws.vfs.write('/archive/document', png)
    const r = await callTool<{ kind: string; mimeType: string; base64: string }>(
      mirageTools(ws).read,
      { path: '/archive/document' },
    )
    expect(r.kind).toBe('media')
    expect(r.mimeType).toBe('image/png')
    expect(Buffer.from(r.base64, 'base64')).toEqual(Buffer.from(png))
  })

  it('reads text whose name has no extension as numbered lines, without a stat', async () => {
    const ws = mkWs()
    await ws.vfs.write('/NOTES', new TextEncoder().encode('one\ntwo\nthree\n'))
    const stat = vi.spyOn(Files.prototype, 'stat')
    const r = await callTool<Answer>(mirageTools(ws).read, { path: '/NOTES', offset: 1, limit: 1 })
    const stats = stat.mock.calls.length
    stat.mockRestore()
    expect(r).toEqual({ text: '     2\ttwo\n', isError: false })
    expect(stats).toBe(0)
  })

  it('counts a media read as a read of the whole file', async () => {
    const ws = mkWs()
    await ws.vfs.write('/photo.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
    const tools = mirageTools(ws)
    const refused = await callTool<Answer>(tools.write, { path: '/photo.png', content: 'x' })
    await callTool(tools.read, { path: '/photo.png' })
    const written = await callTool<Answer>(tools.write, { path: '/photo.png', content: 'x' })
    expect(refused.isError).toBe(true)
    expect(written).toEqual({ text: 'Written: /photo.png', isError: false })
  })

  it('renders each answer for the model', () => {
    const read = mirageTools(mkWs()).read
    expect(callToModelOutput(read, { text: 'hello', isError: false })).toEqual({
      type: 'text',
      value: 'hello',
    })
    expect(callToModelOutput(read, { text: 'nope', isError: true })).toEqual({
      type: 'error-text',
      value: 'nope',
    })
    expect(
      callToModelOutput(read, {
        kind: 'media',
        path: '/p.png',
        mimeType: 'image/png',
        base64: 'AAAA',
        bytes: 3,
      }),
    ).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: '[/p.png] image/png (3 bytes)' },
        { type: 'file', data: { type: 'data', data: 'AAAA' }, mediaType: 'image/png' },
      ],
    })
  })
})
