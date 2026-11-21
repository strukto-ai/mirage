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

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { WorkspaceCallError } from './errors.ts'
import { relayAgent, relayStdio, textSlice, withFiles, withMirage, workspacePath } from './relay.ts'

type JsonRecord = Record<string, JsonValue>

const SERVER: JsonRecord = { name: 'mirage', command: '/bin/mirage', args: [], env: [] }

const PROMPT = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {} },
  },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'session/new',
    params: { cwd: '/home/me/proj', mcpServers: [] },
  },
  { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 's1', prompt: [] } },
]

const AGENT = `
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const receive = async () => {
  const { value, done } = await lines.next()
  return done ? null : JSON.parse(value)
}
const folder = '/home/me/proj'
const asks = [
  ['fs/read_text_file', { path: folder + '/notes.txt', line: 2, limit: 1 }],
  ['fs/write_text_file', { path: folder + '/out.txt', content: 'written\\n' }],
  ['fs/read_text_file', { path: folder + '/missing.txt' }],
  ['fs/read_text_file', { path: 'notes.txt' }],
]
let message
while ((message = await receive()) !== null) {
  let result
  if (message.method === 'initialize') {
    result = { protocolVersion: 1, _meta: { seen: message.params } }
  } else if (message.method === 'session/new') {
    result = { sessionId: 's1', _meta: { seen: message.params } }
  } else if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { x: 1 } })
    const answers = []
    for (const [n, [ask, params]] of asks.entries()) {
      send({ jsonrpc: '2.0', id: 100 + n, method: ask, params: { sessionId: 's1', ...params } })
      answers.push(await receive())
    }
    result = { stopReason: 'end_turn', _meta: { answers } }
  } else continue
  send({ jsonrpc: '2.0', id: message.id, result })
}
process.exit(Number(process.argv[2] ?? 0))
`

const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const app of apps.splice(0)) await app.close()
})

async function daemon(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-acp-relay-'))
  const app = buildApp({ allowedHosts: ['*'], pidFile: join(dir, 'daemon.pid') })
  apps.push(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${String(address.port)}`
  const created = await fetch(`${base}/v1/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } }),
  })
  const { id } = (await created.json()) as { id: string }
  return `${base}/v1/workspaces/${id}/rpc`
}

async function rpc(url: string, method: string, params: JsonRecord): Promise<JsonRecord> {
  const answer = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await answer.json()) as JsonRecord
}

function agent(...args: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-acp-agent-'))
  const script = join(dir, 'agent.mjs')
  writeFileSync(script, AGENT)
  return [process.execPath, script, ...args]
}

function nothing(): AsyncIterable<string> {
  return Readable.from([]) as AsyncIterable<string>
}

const noCall = (method: string): Promise<JsonValue> =>
  Promise.reject(new WorkspaceCallError(-32603, `unexpected ${method}`))

describe('withFiles', () => {
  it('offers both file methods', () => {
    const params = withFiles({ clientCapabilities: { terminal: true, fs: {} } })
    expect(params.clientCapabilities).toEqual({
      terminal: true,
      fs: { readTextFile: true, writeTextFile: true },
    })
  })
})

describe('withMirage', () => {
  it('replaces a server of the same name', () => {
    const other: JsonRecord = { name: 'docs', command: '/bin/docs', args: [], env: [] }
    const stale: JsonRecord = { ...SERVER, command: '/old/mirage' }
    const params = withMirage({ cwd: '/w', mcpServers: [other, stale] }, SERVER)
    expect(params.mcpServers).toEqual([other, SERVER])
    expect(params._meta).toEqual({ claudeCode: { options: { tools: [] } } })
  })

  it('keeps tools the client chose', () => {
    const meta: JsonRecord = { claudeCode: { options: { tools: ['Read'], model: 'm' } } }
    expect(withMirage({ cwd: '/w', _meta: meta }, SERVER)._meta).toEqual(meta)
  })
})

describe('workspacePath', () => {
  it.each([
    ['/home/me/proj/a.txt', '/home/me/proj', '/', '/a.txt'],
    ['/home/me/proj/a.txt', '/home/me/proj/', '/project', '/project/a.txt'],
    ['/home/me/proj', '/home/me/proj', '/project', '/project'],
    ['/home/me/projx/a.txt', '/home/me/proj', '/project', '/home/me/projx/a.txt'],
    ['/etc/hosts', null, '/project', '/etc/hosts'],
    ['/a.txt', '/', '/project', '/project/a.txt'],
  ])('maps %s under %s to %s', (path, cwd, root, expected) => {
    expect(workspacePath(path, cwd, root)).toBe(expected)
  })
})

describe('textSlice', () => {
  it.each([
    [null, null, 'one\ntwo\nthree'],
    [2, null, 'two\nthree'],
    [2, 1, 'two\n'],
    [null, 2, 'one\ntwo\n'],
    [9, 1, ''],
  ])('line %s limit %s', (line, limit, expected) => {
    expect(textSlice('one\ntwo\nthree', line, limit)).toBe(expected)
  })

  it.each([
    ['a\rb\r', 2, 1, 'b\r'],
    ['a\r\nb\nc', 2, null, 'b\nc'],
    ['a\vb\fc\nd', 2, 1, 'd'],
  ])('ends lines at CRLF, CR or LF (%j)', (text, line, limit, expected) => {
    expect(textSlice(text, line, limit)).toBe(expected)
  })
})

describe('relayStdio', () => {
  it("answers the agent's files from the workspace", async () => {
    const url = await daemon()
    await rpc(url, 'vfs/write', {
      path: '/notes.txt',
      data: Buffer.from('one\ntwo\nthree\n').toString('base64'),
    })
    const stdin = new PassThrough()
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin)
    let text = ''
    let done: () => void = () => undefined
    const answered = new Promise<void>((resolve) => {
      done = resolve
    })
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      const line = String(chunk)
      if (line.startsWith('{"jsonrpc"')) {
        text += line
        if ((JSON.parse(line) as JsonRecord).id === 3) done()
      }
      const callback = rest.find((one) => typeof one === 'function') as (() => void) | undefined
      callback?.()
      return true
    })
    stdin.write(PROMPT.map((one) => `${JSON.stringify(one)}\n`).join(''))
    const running = relayStdio(agent(), url, () => Promise.resolve(''), SERVER, '/')
    await answered
    stdin.end()
    expect(await running).toBe(0)
    vi.restoreAllMocks()
    const written = await rpc(url, 'vfs/read', { path: '/out.txt' })
    const messages = text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as JsonRecord)
    const byId = new Map(messages.map((one) => [one.id ?? null, one]))
    const result = (id: number): JsonRecord => byId.get(id)?.result as JsonRecord
    const seen = (id: number): JsonRecord => (result(id)._meta as JsonRecord).seen as JsonRecord
    expect((seen(1).clientCapabilities as JsonRecord).fs).toEqual({
      readTextFile: true,
      writeTextFile: true,
    })
    expect(seen(2).mcpServers).toEqual([SERVER])
    const [readTwo, wrote, missing, relative] = (result(3)._meta as JsonRecord)
      .answers as JsonRecord[]
    expect(readTwo?.result).toEqual({ content: 'two\n' })
    expect(wrote?.result).toEqual({})
    expect((missing?.error as JsonRecord).code).toBe(-32002)
    expect((relative?.error as JsonRecord).code).toBe(-32602)
    const data = (written.result as JsonRecord).data as string
    expect(Buffer.from(data, 'base64').toString()).toBe('written\n')
    const methods = messages.map((one) => one.method)
    expect(methods.filter((one) => one === 'session/update')).toHaveLength(1)
    expect(methods).not.toContain('fs/read_text_file')
    expect(methods).not.toContain('fs/write_text_file')
  }, 30_000)
})

describe('relayAgent', () => {
  it("exits with the agent's status", async () => {
    const written: string[] = []
    const status = await relayAgent(agent('3'), noCall, SERVER, '/', nothing(), (line) => {
      written.push(line)
      return Promise.resolve()
    })
    expect([status, written]).toEqual([3, []])
  })

  it('answers an error for a failed workspace call', async () => {
    const written: JsonRecord[] = []
    let done: () => void = () => undefined
    const answered = new Promise<void>((resolve) => {
      done = resolve
    })
    async function* lines(): AsyncGenerator<string> {
      for (const message of PROMPT) yield JSON.stringify(message)
      await answered
    }
    const unreachable = (): Promise<JsonValue> => Promise.reject(new TypeError('fetch failed'))
    const status = await relayAgent(agent(), unreachable, SERVER, '/', lines(), (line) => {
      written.push(JSON.parse(line) as JsonRecord)
      if (written.at(-1)?.id === 3) done()
      return Promise.resolve()
    })
    const answers = ((written.at(-1)?.result as JsonRecord)._meta as JsonRecord)
      .answers as JsonRecord[]
    const codes = answers.map((one) => (one.error as JsonRecord).code)
    expect([status, codes]).toEqual([0, [-32603, -32603, -32603, -32602]])
  }, 30_000)

  it('stops the agent when the relay fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-acp-stop-'))
    const script = join(dir, 'waits.mjs')
    const pidFile = join(dir, 'agent.pid')
    writeFileSync(
      script,
      "import { writeFileSync } from 'node:fs'\n" +
        'writeFileSync(process.argv[2], String(process.pid))\n' +
        "process.stdout.write('{}\\n')\n" +
        "process.stdin.on('data', () => undefined)\n",
    )
    async function* forever(): AsyncGenerator<string> {
      await new Promise<never>(() => undefined)
      yield ''
    }
    await expect(
      relayAgent([process.execPath, script, pidFile], noCall, SERVER, '/', forever(), () =>
        Promise.reject(new Error('client gone')),
      ),
    ).rejects.toThrow('client gone')
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow()
  }, 30_000)

  it('rejects a missing agent with ENOENT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-acp-none-'))
    await expect(
      relayAgent([join(dir, 'no-such-agent')], noCall, SERVER, '/', nothing(), () =>
        Promise.resolve(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
