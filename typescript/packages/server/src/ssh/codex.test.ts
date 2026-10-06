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

import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import ssh2, { type Client, type ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceRegistry, type WorkspaceEntry } from '../registry.ts'
import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_NOT_FOUND,
} from '../rpc/constants.ts'
import { argvLine, processEnv, toPath, toUri } from './codex.ts'
import { CODEX_RETAINED_OUTPUT, CODEX_SUBSYSTEM } from './constants.ts'
import { CodexRPCError } from './errors.ts'
import { mintKeyPair } from './keys.ts'
import { startSSHServer } from './server.ts'
import type { SSHListener } from './types.ts'

type Message = Record<string, unknown>

interface Harness {
  registry: WorkspaceRegistry
  entry: WorkspaceEntry
  listener: SSHListener
  privateKey: string
  keysFile: string
}

const TIMEOUT = 10_000
const WALK = { maxDepth: 3, maxDirectories: 10, maxEntries: 100, followDirectorySymlinks: false }
const open: Harness[] = []
const clients: Client[] = []

async function startHarness(mode: MountMode = MountMode.WRITE, ws?: Workspace): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-codex-'))
  const pair = mintKeyPair(ssh2.utils)
  writeFileSync(join(dir, 'authorized_keys'), `${pair.public}\n`)
  const registry = new WorkspaceRegistry({ idleGraceSeconds: 0 })
  const entry = registry.add(ws ?? new Workspace({ '/': new RAMVFS() }, { mode }), 'demo')
  const listener = await startSSHServer(registry, {
    port: 0,
    host: '127.0.0.1',
    hostKeyFile: join(dir, 'host_key'),
    authorizedKeysFile: join(dir, 'authorized_keys'),
  })
  const harness = {
    registry,
    entry,
    listener,
    privateKey: pair.private,
    keysFile: join(dir, 'authorized_keys'),
  }
  open.push(harness)
  return harness
}

function connect(h: Harness, username = 'demo', privateKey = h.privateKey): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    clients.push(client)
    client.on('ready', () => {
      resolve(client)
    })
    client.on('error', reject)
    client.connect({ host: '127.0.0.1', port: h.listener.port, username, privateKey })
  })
}

/** Authorize a fresh client key whose line carries `options`. */
function bindKey(h: Harness, options: string): string {
  const pair = mintKeyPair(ssh2.utils)
  appendFileSync(h.keysFile, `${options} ${pair.public}\n`)
  return pair.private
}

/** A workspace whose `guarded` profile seals `/vault`. */
async function vaultWorkspace(): Promise<Workspace> {
  const ws = new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      profiles: {
        guarded: { commands: { deny: [{ reason: 'the vault is sealed', paths: ['/vault/*'] }] } },
      },
    },
  )
  await ws.shell('mkdir -p /vault && echo token > /vault/secret')
  return ws
}

function subsystem(client: Client, name: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.subsys(name, (err, stream) => {
      if (err !== undefined) reject(err)
      else resolve(stream)
    })
  })
}

const b64 = (text: string): string => Buffer.from(text).toString('base64')
const unb64 = (text: unknown): string => Buffer.from(String(text), 'base64').toString()

/** Codex's side of one codex-exec channel, one request at a time. */
class CodexClient {
  readonly notes: Message[] = []
  private buffer = ''
  private readonly lines: string[] = []
  private closed = false
  private waiters: (() => void)[] = []
  private id = 0

  constructor(readonly stream: ClientChannel) {
    stream.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let cut = this.buffer.indexOf('\n')
      while (cut >= 0) {
        this.lines.push(this.buffer.slice(0, cut))
        this.buffer = this.buffer.slice(cut + 1)
        cut = this.buffer.indexOf('\n')
      }
      this.wake()
    })
    stream.on('close', () => {
      this.closed = true
      this.wake()
    })
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  async receive(): Promise<Message> {
    const deadline = Date.now() + TIMEOUT
    while (this.lines.length === 0) {
      if (this.closed) throw new Error('the channel closed')
      if (Date.now() > deadline) throw new Error('timed out waiting for a message')
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 200)
      })
    }
    return JSON.parse(this.lines.shift() ?? '') as Message
  }

  write(text: string): void {
    this.stream.write(text)
  }

  send(method: string, params: Message = {}): number {
    this.id += 1
    this.write(JSON.stringify({ id: this.id, method, params }) + '\n')
    return this.id
  }

  async response(id: number): Promise<Message> {
    const index = this.notes.findIndex((n) => n.id === id && !('method' in n))
    const noted = index >= 0 ? this.notes.splice(index, 1)[0] : undefined
    if (noted !== undefined) return noted
    for (;;) {
      const message = await this.receive()
      if (message.id === id && !('method' in message)) return message
      this.notes.push(message)
    }
  }

  call(method: string, params: Message = {}): Promise<Message> {
    return this.response(this.send(method, params))
  }

  async result(method: string, params: Message = {}): Promise<Message> {
    const message = await this.call(method, params)
    expect(message).not.toHaveProperty('error')
    return message.result as Message
  }

  async error(method: string, params: Message = {}): Promise<Message> {
    const message = await this.call(method, params)
    expect(message).toHaveProperty('error')
    return message.error as Message
  }

  async noteAny(processId: string, method?: string): Promise<Message> {
    for (;;) {
      const index = this.notes.findIndex(
        (n) =>
          (n.params as Message | undefined)?.processId === processId &&
          (method === undefined || n.method === method),
      )
      if (index >= 0) return this.notes.splice(index, 1)[0]?.params as Message
      this.notes.push(await this.receive())
    }
  }

  async start(processId: string, script: string, extra: Message = {}): Promise<void> {
    await this.result('process/start', {
      processId,
      argv: ['/bin/bash', '-lc', script],
      cwd: 'file:///',
      env: {},
      ...extra,
    })
  }

  async run(
    processId: string,
    script: string,
    extra: Message = {},
  ): Promise<[string, string, number]> {
    await this.start(processId, script, extra)
    let out = ''
    let err = ''
    for (;;) {
      const params = await this.noteAny(processId)
      if ('chunk' in params) {
        if (params.stream === 'stderr') err += unb64(params.chunk)
        else out += unb64(params.chunk)
      } else if ('exitCode' in params) {
        return [out, err, params.exitCode as number]
      }
    }
  }
}

async function codex(h: Harness, privateKey?: string): Promise<CodexClient> {
  const client = new CodexClient(
    await subsystem(await connect(h, 'demo', privateKey), CODEX_SUBSYSTEM),
  )
  await client.result('initialize', { clientName: 'test', resumeSessionId: null })
  client.write(JSON.stringify({ method: 'initialized' }) + '\n')
  return client
}

function sshSessions(h: Harness): string[] {
  return h.entry.runner.ws
    .listSessions()
    .map((s) => s.sessionId)
    .filter((id) => id.startsWith('ssh_'))
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.end()
  for (const h of open.splice(0)) {
    await h.listener.close()
    await h.registry.closeAll()
  }
})

describe('helpers', () => {
  it.each([
    ['file:///', '/'],
    ['file:///a/b/../c', '/a/c'],
    ['file:///a%20b', '/a b'],
    ['file:////twice', '/twice'],
  ])('reads %s as the workspace path %s', (uri, path) => {
    expect(toPath(uri)).toBe(path)
  })

  it.each(['/no/scheme', 'http://x/y', 'file:rel', 3])('refuses %s as a path', (uri) => {
    const err = (() => {
      try {
        toPath(uri)
      } catch (e) {
        return e
      }
      return null
    })()
    expect(err).toBeInstanceOf(CodexRPCError)
    expect((err as CodexRPCError).code).toBe(RPC_INVALID_PARAMS)
  })

  it('sends a path back out quoted', () => {
    expect(toUri('/a b/c')).toBe('file:///a%20b/c')
  })

  it.each([
    [['/usr/bin/bash', '-lc', 'ls | wc -l'], 'ls | wc -l'],
    [['sh', '-c', 'echo hi'], 'echo hi'],
    [['grep', '-n', 'a b', '/f'], "grep -n 'a b' /f"],
    [['bash', '-c', 'echo $1', 'sh', 'x'], "bash -c 'echo $1' sh x"],
  ])('runs %j as the line %s', (argv, line) => {
    expect(argvLine(argv)).toBe(line)
  })

  it('lays env over the policy set', () => {
    const params = {
      env: { A: 'env', C: 'env' },
      envPolicy: { inherit: 'all', set: { A: 'set', B: 'set' } },
    }
    expect(processEnv(params)).toEqual({ A: 'env', B: 'set', C: 'env' })
  })
})

describe('codex-exec', () => {
  it('names the session and its shell', async () => {
    const client = await codex(await startHarness())
    expect(await client.result('environment/info')).toEqual({
      shell: { name: 'bash', path: '/bin/bash' },
      cwd: 'file:///',
      capabilities: {},
    })
  })

  it('round trips files the shell sees', async () => {
    const client = await codex(await startHarness())
    await client.result('fs/createDirectory', { path: 'file:///notes', recursive: true })
    await client.result('fs/writeFile', { path: 'file:///notes/a.txt', dataBase64: b64('hello\n') })
    const read = await client.result('fs/readFile', { path: 'file:///notes/a.txt' })
    const [out, , code] = await client.run('p1', 'cat /notes/a.txt')
    const meta = await client.result('fs/getMetadata', { path: 'file:///notes/a.txt' })
    expect(unb64(read.dataBase64)).toBe('hello\n')
    expect([out, code]).toEqual(['hello\n', 0])
    expect(meta).toMatchObject({ isFile: true, isDirectory: false, isSymlink: false, size: 6 })
  })

  it('carries a file larger than the ssh window whole', async () => {
    const client = await codex(await startHarness())
    const data = 'x'.repeat(3 * 1024 * 1024)
    await client.result('fs/writeFile', { path: 'file:///big', dataBase64: b64(data) })
    const read = await client.result('fs/readFile', { path: 'file:///big' })
    expect(unb64(read.dataBase64) === data).toBe(true)
  })

  it('answers a missing path as not found', async () => {
    const client = await codex(await startHarness())
    const errors: Message[] = []
    for (const method of ['fs/getMetadata', 'fs/readFile', 'fs/readDirectory', 'fs/canonicalize']) {
      errors.push(await client.error(method, { path: 'file:///nope' }))
    }
    errors.push(
      await client.error('fs/remove', { path: 'file:///nope', recursive: false, force: false }),
    )
    const forced = await client.result('fs/remove', {
      path: 'file:///nope',
      recursive: false,
      force: true,
    })
    for (const error of errors) {
      expect(error).toEqual({ code: RPC_NOT_FOUND, message: 'No such file or directory' })
    }
    expect(forced).toEqual({})
  })

  it('answers file errors as the exec-server does', async () => {
    const client = await codex(await startHarness())
    await client.run('seed', 'mkdir -p /d/full && echo x > /d/full/f')
    const notFile = await client.error('fs/readFile', { path: 'file:///d' })
    const noParent = await client.error('fs/writeFile', {
      path: 'file:///new/f',
      dataBase64: b64('x'),
    })
    const exists = await client.error('fs/createDirectory', { path: 'file:///d', recursive: false })
    const mkdirNoParent = await client.error('fs/createDirectory', {
      path: 'file:///a/b',
      recursive: false,
    })
    const copyTree = await client.error('fs/copy', {
      sourcePath: 'file:///d',
      destinationPath: 'file:///e',
      recursive: false,
    })
    const notEmpty = await client.error('fs/remove', {
      path: 'file:///d/full',
      recursive: false,
      force: false,
    })
    expect(notFile).toEqual({ code: RPC_INVALID_REQUEST, message: 'path `/d` is not a file' })
    expect(noParent.code).toBe(RPC_NOT_FOUND)
    expect(exists).toEqual({ code: RPC_INTERNAL_ERROR, message: 'File exists' })
    expect(mkdirNoParent.code).toBe(RPC_NOT_FOUND)
    expect(copyTree.code).toBe(RPC_INVALID_REQUEST)
    expect(String(copyTree.message)).toContain('recursive: true')
    expect(notEmpty).toEqual({ code: RPC_INTERNAL_ERROR, message: 'Directory not empty' })
  })

  it('copies and removes trees recursively', async () => {
    const client = await codex(await startHarness())
    await client.run('seed', 'mkdir -p /src/in && echo y > /src/in/f')
    await client.result('fs/copy', {
      sourcePath: 'file:///src',
      destinationPath: 'file:///dst',
      recursive: true,
    })
    await client.result('fs/remove', { path: 'file:///src', recursive: true, force: false })
    const [out] = await client.run('check', 'cat /dst/in/f; test -e /src || echo gone')
    expect(out).toBe('y\ngone\n')
  })

  it('lists a directory by kind and canonicalizes a path', async () => {
    const client = await codex(await startHarness())
    await client.run('seed', 'mkdir -p /w/sub && echo a > /w/a.txt')
    const listing = await client.result('fs/readDirectory', { path: 'file:///w' })
    const canonical = await client.result('fs/canonicalize', { path: 'file:///w/sub/../a.txt' })
    const entries = [...(listing.entries as Message[])].sort((a, b) =>
      String(a.fileName).localeCompare(String(b.fileName)),
    )
    expect(entries).toEqual([
      { fileName: 'a.txt', isDirectory: false, isFile: true },
      { fileName: 'sub', isDirectory: true, isFile: false },
    ])
    expect(canonical).toEqual({ path: 'file:///w/a.txt' })
  })

  it('walks breadth first within its limits', async () => {
    const client = await codex(await startHarness())
    await client.run(
      'seed',
      'mkdir -p /w/sub/deep && echo > /w/a.txt && echo > /w/sub/b.txt && echo > /w/sub/deep/c.txt',
    )
    const walk = (options: Message): Promise<Message> =>
      client.result('fs/walk', { path: 'file:///w', options: { ...WALK, ...options } })
    const paths = (result: Message): string[] =>
      (result.entries as Message[]).map((e) => String(e.path).replace('file:///w', ''))
    const shallow = await walk({ maxDepth: 0 })
    const one = await walk({ maxDepth: 1 })
    const capped = await walk({ maxEntries: 1 })
    const rooted = await walk({ maxDirectories: 1 })
    const ofFile = await client.result('fs/walk', { path: 'file:///w/a.txt', options: WALK })
    const zero = await client.error('fs/walk', {
      path: 'file:///w',
      options: { ...WALK, maxEntries: 0 },
    })
    expect(paths(shallow)).toEqual(['/a.txt', '/sub'])
    expect(paths(one)).toEqual(['/a.txt', '/sub', '/sub/b.txt', '/sub/deep'])
    expect([shallow.truncated, shallow.errors]).toEqual([false, []])
    expect([paths(capped), capped.truncated]).toEqual([['/a.txt'], true])
    expect([paths(rooted), rooted.truncated]).toEqual([['/a.txt', '/sub'], true])
    expect(ofFile).toEqual({ entries: [], errors: [], truncated: false })
    expect(zero.code).toBe(RPC_INVALID_REQUEST)
  })

  it('reads a file in blocks through a handle', async () => {
    const client = await codex(await startHarness())
    await client.result('fs/writeFile', { path: 'file:///f', dataBase64: b64('hello\nworld\n') })
    await client.result('fs/open', { path: 'file:///f', handleId: 'h' })
    const again = await client.error('fs/open', { path: 'file:///f', handleId: 'h' })
    const first = await client.result('fs/readBlock', { handleId: 'h', offset: 0, len: 5 })
    const last = await client.result('fs/readBlock', { handleId: 'h', offset: 10, len: 50 })
    await client.result('fs/close', { handleId: 'h' })
    await client.result('fs/close', { handleId: 'h' })
    const gone = await client.error('fs/readBlock', { handleId: 'h', offset: 0, len: 1 })
    expect(again.code).toBe(RPC_INVALID_REQUEST)
    expect([unb64(first.chunk), first.eof]).toEqual(['hello', false])
    expect([unb64(last.chunk), last.eof]).toEqual(['d\n', true])
    expect(gone.code).toBe(RPC_NOT_FOUND)
  })

  it('streams a process output, then its exit', async () => {
    const client = await codex(await startHarness())
    await client.start('p', 'echo out; echo err >&2; exit 3')
    const out = await client.noteAny('p', 'process/output')
    const err = await client.noteAny('p', 'process/output')
    const exited = await client.noteAny('p', 'process/exited')
    const closed = await client.noteAny('p', 'process/closed')
    const read = await client.result('process/read', { processId: 'p', afterSeq: 0 })
    const after = await client.result('process/read', { processId: 'p', afterSeq: 2 })
    const stopped = await client.result('process/terminate', { processId: 'p' })
    expect([out.seq, out.stream, unb64(out.chunk)]).toEqual([1, 'stdout', 'out\n'])
    expect([err.seq, err.stream]).toEqual([2, 'stderr'])
    expect(exited).toEqual({ processId: 'p', seq: 3, exitCode: 3, sandboxDenied: false })
    expect(closed).toEqual({ processId: 'p', seq: 4 })
    expect((read.chunks as Message[]).map((c) => c.seq)).toEqual([1, 2])
    expect(read).toMatchObject({ nextSeq: 5, exited: true, closed: true, exitCode: 3 })
    expect(after.chunks).toEqual([])
    expect(stopped).toEqual({ running: false })
  })

  it('reports a terminal process as one stream', async () => {
    const client = await codex(await startHarness())
    const [out, err, code] = await client.run('t', 'echo a; echo b >&2', { tty: true })
    expect([out, err, code]).toEqual(['a\nb\n', '', 0])
  })

  it('runs a process in its cwd with its env', async () => {
    const client = await codex(await startHarness())
    await client.run('seed', 'mkdir -p /work')
    const [out] = await client.run('p', 'pwd; echo $FOO', {
      cwd: 'file:///work',
      env: { FOO: 'bar' },
    })
    const [home] = await client.run('q', 'pwd; echo ${FOO:-unset}')
    expect(out).toBe('/work\nbar\n')
    expect(home).toBe('/\nunset\n')
  })

  it('feeds a piped process what codex writes', async () => {
    const client = await codex(await startHarness())
    await client.start('p', 'read x; echo got:$x', { pipeStdin: true })
    const status = await client.result('process/write', {
      processId: 'p',
      writeId: 'w1',
      chunk: b64('hi\n'),
    })
    const out = await client.noteAny('p', 'process/output')
    const closed = await client.run('q', 'cat')
    const refused = await client.result('process/write', {
      processId: 'q',
      writeId: 'w2',
      chunk: b64('x'),
    })
    const unknown = await client.result('process/write', {
      processId: 'nope',
      writeId: 'w3',
      chunk: '',
    })
    expect(status).toEqual({ status: 'accepted' })
    expect(unb64(out.chunk)).toBe('got:hi\n')
    expect(closed).toEqual(['', '', 0])
    expect(refused).toEqual({ status: 'stdinClosed' })
    expect(unknown).toEqual({ status: 'unknownProcess' })
  })

  it('stops a process on interrupt and terminate', async () => {
    const client = await codex(await startHarness())
    await client.start('i', 'sleep 30')
    const bad = await client.error('process/signal', { processId: 'i', signal: 'kill' })
    await client.result('process/signal', { processId: 'i', signal: 'interrupt' })
    const interrupted = await client.noteAny('i', 'process/exited')
    await client.start('t', 'sleep 30')
    const running = await client.result('process/terminate', { processId: 't' })
    const terminated = await client.noteAny('t', 'process/exited')
    await client.start('c', 'sleep 30', { tty: true })
    await client.result('process/write', { processId: 'c', writeId: 'w', chunk: b64('\x03') })
    const ctrlC = await client.noteAny('c', 'process/exited')
    expect(bad.code).toBe(RPC_INVALID_PARAMS)
    expect(interrupted.exitCode).toBe(130)
    expect(running).toEqual({ running: true })
    expect(terminated.exitCode).toBe(-1)
    expect(ctrlC.exitCode).toBe(130)
  })

  it('answers a signal while a read waits', async () => {
    const client = await codex(await startHarness())
    await client.start('s', 'sleep 30')
    const readId = client.send('process/read', { processId: 's', afterSeq: 0, waitMs: 20_000 })
    const started = Date.now()
    await client.result('process/signal', { processId: 's', signal: 'interrupt' })
    const read = (await client.response(readId)).result as Message
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(read).toMatchObject({ exited: true, exitCode: 130 })
  })

  it('forgets a process once it is terminated', async () => {
    const client = await codex(await startHarness())
    await client.run('p', 'echo once')
    await client.noteAny('p', 'process/closed')
    await client.result('process/terminate', { processId: 'p' })
    const gone = await client.error('process/read', { processId: 'p' })
    const [again] = await client.run('p', 'echo twice')
    await client.start('t', 'sleep 30')
    await client.result('process/terminate', { processId: 't' })
    await client.noteAny('t', 'process/closed')
    const stopped = await client.error('process/read', { processId: 't' })
    expect(gone.code).toBe(RPC_INVALID_REQUEST)
    expect(again).toBe('twice\n')
    expect(stopped.code).toBe(RPC_INVALID_REQUEST)
  })

  it('bounds the output it keeps for reads', async () => {
    const client = await codex(await startHarness())
    const [out, , code] = await client.run('big', 'seq 1 300000')
    const read = await client.result('process/read', { processId: 'big' })
    const kept = (read.chunks as Message[]).reduce(
      (n, c) => n + Buffer.from(String(c.chunk), 'base64').byteLength,
      0,
    )
    expect(code).toBe(0)
    expect(out.length).toBeGreaterThan(CODEX_RETAINED_OUTPUT)
    expect(out.endsWith('299999\n300000\n')).toBe(true)
    expect(kept).toBeLessThanOrEqual(CODEX_RETAINED_OUTPUT)
  })

  it('checks process ids', async () => {
    const client = await codex(await startHarness())
    await client.run('p', 'true')
    const dup = await client.error('process/start', {
      processId: 'p',
      argv: ['true'],
      cwd: 'file:///',
      env: {},
    })
    const unknown = await client.error('process/read', { processId: 'nope' })
    const gone = await client.result('process/terminate', { processId: 'nope' })
    expect(dup).toEqual({ code: RPC_INVALID_REQUEST, message: 'process p already exists' })
    expect(unknown).toEqual({ code: RPC_INVALID_REQUEST, message: 'unknown process id nope' })
    expect(gone).toEqual({ running: false })
  })

  it('refuses unknown methods and bad params', async () => {
    const client = await codex(await startHarness())
    const unknown = await client.error('http/request')
    const missing = await client.error('fs/getMetadata')
    const relative = await client.error('fs/getMetadata', { path: '/x' })
    client.write('{nope\n')
    const parse = await client.receive()
    expect(unknown.code).toBe(RPC_METHOD_NOT_FOUND)
    expect(missing).toEqual({ code: RPC_INVALID_PARAMS, message: 'missing field `path`' })
    expect(relative.code).toBe(RPC_INVALID_PARAMS)
    expect(parse.id).toBeNull()
    expect((parse.error as Message).code).toBe(-32700)
  })

  it('records commands in history, not file calls', async () => {
    const client = await codex(await startHarness())
    await client.run('p', 'echo from-codex')
    await client.result('fs/writeFile', { path: 'file:///quiet', dataBase64: b64('x') })
    const [out] = await client.run('h', 'cat /.bash_history')
    expect(out).toContain('echo from-codex')
    expect(out).not.toContain('quiet')
  })

  it('refuses writes on a read-only mount', async () => {
    const client = await codex(await startHarness(MountMode.READ))
    const error = await client.error('fs/writeFile', { path: 'file:///nope', dataBase64: b64('x') })
    expect(error.code).toBe(RPC_INTERNAL_ERROR)
  })

  it('runs under the key profile', async () => {
    const h = await startHarness(MountMode.WRITE, await vaultWorkspace())
    const guarded = bindKey(h, 'mirage-profile="guarded"')
    const opened = await (await codex(h)).result('fs/readFile', { path: 'file:///vault/secret' })
    const client = await codex(h, guarded)
    const refused = await client.error('fs/readFile', { path: 'file:///vault/secret' })
    const [, err, code] = await client.run('p', 'cat /vault/secret')
    expect(unb64(opened.dataBase64)).toBe('token\n')
    expect(refused.code).toBe(RPC_INTERNAL_ERROR)
    expect(code).not.toBe(0)
    expect(err).not.toBe('')
  })

  it('closes its session when the channel ends', async () => {
    const h = await startHarness()
    const client = await codex(h)
    await client.run('p', 'true')
    client.stream.end()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sshSessions(h)).toEqual([])
  })

  it('refuses an unknown workspace', async () => {
    const client = await connect(await startHarness(), 'nope')
    const run = await new Promise<{ stderr: string; code: number | null }>((resolve, reject) => {
      client.subsys(CODEX_SUBSYSTEM, (err, stream) => {
        if (err !== undefined) {
          reject(err)
          return
        }
        const got = { stderr: '', code: null as number | null }
        stream.resume()
        stream.stderr.on('data', (d: Buffer) => {
          got.stderr += d.toString()
        })
        stream.on('exit', (code: number | null) => {
          got.code = code
        })
        stream.on('close', () => {
          resolve(got)
        })
      })
    })
    expect(run).toEqual({ stderr: 'mirage: no such workspace: nope\n', code: 1 })
  })
})
