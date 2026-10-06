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

import { Readable } from 'node:stream'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { MirageRpcServer } from './server.ts'

function server(): MirageRpcServer {
  return new MirageRpcServer(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }))
}

async function call(
  rpc: MirageRpcServer,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await rpc.handle({ jsonrpc: '2.0', id: 1, method, params })
  if (response === null) throw new Error('no response')
  return response
}

const b64 = (text: string): string => Buffer.from(text).toString('base64')

describe('MirageRpcServer', () => {
  it('initialize names the session and the methods', async () => {
    const rpc = server()
    const result = (await call(rpc, 'initialize', {})).result as Record<string, unknown>
    expect(result.protocol_version).toBe('1')
    expect(result.session_id).toBe(rpc.sessionId)
    expect(result.methods).toContain('vfs/read')
  })

  it('shell answers like session.shell', async () => {
    const rpc = server()
    const result = (await call(rpc, 'shell', { command: 'echo hi; echo err >&2' }))
      .result as Record<string, unknown>
    expect([result.exit_code, result.stdout, result.stderr]).toEqual([0, 'hi\n', 'err\n'])
    const stdin = (await call(rpc, 'shell', { command: 'wc -c', stdin_base64: b64('abc') }))
      .result as { stdout: string }
    expect(stdin.stdout.trim()).toBe('3')
  })

  it('vfs methods mirror the ops', async () => {
    const rpc = server()
    expect((await call(rpc, 'vfs/mkdir', { path: '/d' })).result).toEqual({})
    await call(rpc, 'vfs/write', { path: '/d/a.txt', data_base64: b64('one\n') })
    await call(rpc, 'vfs/append', { path: '/d/a.txt', data_base64: b64('two\n') })
    const read = (await call(rpc, 'vfs/read', { path: '/d/a.txt' })).result as {
      data_base64: string
    }
    expect(Buffer.from(read.data_base64, 'base64').toString()).toBe('one\ntwo\n')
    const sliced = (await call(rpc, 'vfs/read', { path: '/d/a.txt', offset: 4, size: 3 }))
      .result as { data_base64: string }
    expect(Buffer.from(sliced.data_base64, 'base64').toString()).toBe('two')
    const stat = (await call(rpc, 'vfs/stat', { path: '/d/a.txt' })).result as Record<
      string,
      unknown
    >
    expect([stat.type, stat.size]).toEqual(['file', 8])
    await call(rpc, 'vfs/rename', { src: '/d/a.txt', dst: '/d/b.txt' })
    await call(rpc, 'vfs/truncate', { path: '/d/b.txt', length: 3 })
    expect((await call(rpc, 'vfs/exists', { path: '/d/b.txt' })).result).toEqual({ exists: true })
    expect((await call(rpc, 'glob', { pattern: '/d/*.txt' })).result).toEqual({
      paths: ['/d/b.txt'],
    })
    await call(rpc, 'vfs/unlink', { path: '/d/b.txt' })
    await call(rpc, 'vfs/rmdir', { path: '/d' })
    expect((await call(rpc, 'vfs/exists', { path: '/d' })).result).toEqual({ exists: false })
  })

  it('tools are the MCP tools', async () => {
    const rpc = server()
    const tools = ((await call(rpc, 'tools/list', {})).result as { tools: { name: string }[] })
      .tools
    expect(tools.map((tool) => tool.name)).toEqual([
      'shell',
      'read',
      'write',
      'edit',
      'ls',
      'grep',
      'glob',
    ])
    const written = await call(rpc, 'tools/call', {
      name: 'write',
      arguments: { path: '/n.txt', content: 'x\n' },
    })
    expect(written.result).toEqual({ text: 'Written: /n.txt', is_error: false })
    const bad = await call(rpc, 'tools/call', { name: 'read', arguments: {} })
    expect((bad.error as { code: number }).code).toBe(-32602)
  })

  it('errors carry codes and the errno', async () => {
    const rpc = server()
    const missing = (await call(rpc, 'vfs/read', { path: '/nope' })).error as {
      code: number
      data: { errno: string }
    }
    expect([missing.code, missing.data.errno]).toEqual([-32004, 'ENOENT'])
    expect(((await call(rpc, 'nope', {})).error as { code: number }).code).toBe(-32601)
    expect(((await call(rpc, 'vfs/read', { path: 3 })).error as { code: number }).code).toBe(-32602)
    expect(await rpc.handle({ jsonrpc: '2.0', method: 'shell' })).toBeNull()
  })

  it('runs nothing for a message without jsonrpc 2.0', async () => {
    const rpc = server()
    await call(rpc, 'vfs/write', { path: '/keep.txt', data_base64: b64('x') })
    const refused = await rpc.handle({
      id: 2,
      method: 'vfs/unlink',
      params: { path: '/keep.txt' },
    })
    expect((refused?.error as { code: number } | undefined)?.code).toBe(-32600)
    expect((await call(rpc, 'vfs/exists', { path: '/keep.txt' })).result).toEqual({
      exists: true,
    })
  })

  it('starts nothing for a request cancelled before it runs', async () => {
    const rpc = server()
    const cancelled = await rpc.handle(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'vfs/write',
        params: { path: '/late.txt', data_base64: b64('x') },
      },
      AbortSignal.abort(),
    )
    expect((cancelled?.error as { code: number } | undefined)?.code).toBe(-32800)
    expect((await call(rpc, 'vfs/exists', { path: '/late.txt' })).result).toEqual({
      exists: false,
    })
  })

  it('serve answers lines and cancels a running request', async () => {
    const rpc = server()
    const out: Record<string, unknown>[] = []
    async function* lines(): AsyncGenerator<string> {
      yield JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'shell',
        params: { command: 'sleep 20' },
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      yield JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } })
      yield 'not json'
    }
    await rpc.serve(Readable.from(lines()), (text) => {
      out.push(JSON.parse(text) as Record<string, unknown>)
    })
    const byId = new Map(out.map((message) => [message.id ?? null, message]))
    expect((byId.get(1)?.error as { code: number }).code).toBe(-32800)
    expect((byId.get(null)?.error as { code: number }).code).toBe(-32700)
  })
})
