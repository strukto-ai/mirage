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
import { PassThrough } from 'node:stream'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import ssh2, { type Client, type ClientChannel, type ServerChannel } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceRegistry, type WorkspaceEntry } from '../registry.ts'
import { mintKeyPair } from './keys.ts'
import { startSSHServer } from './server.ts'
import { endsShell, handleChannel, loginEnv } from './session.ts'
import type { SSHListener } from './types.ts'

interface Harness {
  registry: WorkspaceRegistry
  entry: WorkspaceEntry
  listener: SSHListener
  privateKey: string
  keysFile: string
}

interface Run {
  stdout: string
  stderr: string
  code: number | null
}

const open: Harness[] = []
const clients: Client[] = []

async function startHarness(ws?: Workspace): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-session-'))
  const pair = mintKeyPair(ssh2.utils)
  writeFileSync(join(dir, 'authorized_keys'), `${pair.public}\n`)
  const registry = new WorkspaceRegistry({ idleGraceSeconds: 0 })
  const entry = registry.add(
    ws ?? new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }),
    'demo',
  )
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

function collect(stream: ClientChannel, stdin?: string): Promise<Run> {
  return new Promise((resolve) => {
    const run: Run = { stdout: '', stderr: '', code: null }
    stream.on('data', (d: Buffer) => {
      run.stdout += d.toString()
    })
    stream.stderr.on('data', (d: Buffer) => {
      run.stderr += d.toString()
    })
    stream.on('exit', (code: number | null) => {
      run.code = code
    })
    stream.on('close', () => {
      resolve(run)
    })
    if (stdin !== undefined) stream.end(stdin)
  })
}

function exec(client: Client, command: string, stdin?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err !== undefined) {
        reject(err)
        return
      }
      void collect(stream, stdin).then(resolve)
    })
  })
}

function shell(client: Client, term: string | null): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const window = term === null ? false : { term, rows: 24, cols: 80, width: 0, height: 0 }
    client.shell(window, (err, stream) => {
      if (err !== undefined) reject(err)
      else resolve(stream)
    })
  })
}

async function readUntil(stream: ClientChannel, needle: string, ms = 10_000): Promise<string> {
  let seen = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.off('data', onData)
      reject(new Error(`never saw ${JSON.stringify(needle)} in ${JSON.stringify(seen)}`))
    }, ms)
    const onData = (d: Buffer): void => {
      seen += d.toString()
      if (seen.includes(needle)) {
        clearTimeout(timer)
        stream.off('data', onData)
        resolve(seen)
      }
    }
    stream.on('data', onData)
  })
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

describe('endsShell', () => {
  it.each([
    ['exit', true],
    ['  exit 3  ', true],
    ['exit 1 2', false],
    ['exitcode', false],
    ['echo exit', false],
    ['', false],
  ])('%j leaves: %s', (line, leaves) => {
    expect(endsShell(line)).toBe(leaves)
  })
})

describe('loginEnv', () => {
  it('is what sshd hands a login', () => {
    const request = {
      username: 'demo',
      profile: [],
      account: [],
      command: null,
      term: 'xterm-256color',
      peer: { address: '10.0.0.5', port: 40000 },
      local: { address: '10.0.0.1', port: 2222 },
    }
    expect(loginEnv(request)).toEqual({
      HOME: '/',
      USER: 'demo',
      LOGNAME: 'demo',
      SSH_CLIENT: '10.0.0.5 40000 2222',
      SSH_CONNECTION: '10.0.0.5 40000 10.0.0.1 2222',
      TERM: 'xterm-256color',
    })
    expect(loginEnv({ ...request, term: null })).not.toHaveProperty('TERM')
  })
})

describe('command channels', () => {
  it('return both streams and the status', async () => {
    const client = await connect(await startHarness())
    expect(await exec(client, 'echo out; echo err >&2; exit 3')).toEqual({
      stdout: 'out\n',
      stderr: 'err\n',
      code: 3,
    })
  })

  it('read piped stdin', async () => {
    const client = await connect(await startHarness())
    const run = await exec(client, 'cat > /notes && wc -l < /notes', 'a\nb\nc\n')
    expect(run.stdout.trim()).toBe('3')
  })

  it('do not wait for stdin they never read', async () => {
    const client = await connect(await startHarness())
    expect((await exec(client, 'echo quick')).stdout).toBe('quick\n')
  })

  it('each run as a fresh session, closed when the channel ends', async () => {
    const h = await startHarness()
    const client = await connect(h)
    await exec(client, 'mkdir -p /work && cd /work && export SEEN=1')
    expect((await exec(client, 'pwd; echo "seen=${SEEN:-no}"')).stdout).toBe('/\nseen=no\n')
    expect(sshSessions(h)).toEqual([])
  })

  it('carry the login environment', async () => {
    const client = await connect(await startHarness())
    expect((await exec(client, 'echo "$HOME $USER $LOGNAME"; cd; pwd')).stdout).toBe(
      '/ demo demo\n/\n',
    )
  })

  it('keep a value the profile set over the login default', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { mode: MountMode.WRITE, profiles: { agent: { env: { HOME: '/work' } } }, profile: 'agent' },
    )
    const client = await connect(await startHarness(ws))
    expect((await exec(client, 'echo "$HOME $USER"')).stdout).toBe('/work demo\n')
  })

  it('are recorded in history, the login line is not', async () => {
    const client = await connect(await startHarness())
    await exec(client, 'echo remembered')
    const history = (await exec(client, 'cat /.bash_history')).stdout
    expect(history).toContain('echo remembered')
    expect(history).not.toContain('export HOME')
  })

  it('refuse an unknown workspace by name', async () => {
    const client = await connect(await startHarness(), 'nope')
    expect(await exec(client, 'echo hi')).toEqual({
      stdout: '',
      stderr: 'mirage: no such workspace: nope\n',
      code: 1,
    })
  })

  it('are cancelled when the connection drops', async () => {
    const h = await startHarness()
    const client = await connect(h)
    client.exec('sleep 30', () => undefined)
    await new Promise((r) => setTimeout(r, 300))
    client.end()
    const started = Date.now()
    while (sshSessions(h).length > 0) {
      expect(Date.now() - started).toBeLessThan(10_000)
      await new Promise((r) => setTimeout(r, 100))
    }
  })
})

describe('shell channels', () => {
  it('without a terminal run lines until exit', async () => {
    const client = await connect(await startHarness())
    const stream = await shell(client, null)
    expect(await collect(stream, 'cd /\necho in\nexit 4\necho never\n')).toEqual({
      stdout: 'in\n',
      stderr: '',
      code: 4,
    })
  })

  it('without a terminal end at end of input', async () => {
    const client = await connect(await startHarness())
    const stream = await shell(client, null)
    expect(await collect(stream, 'false\n')).toEqual({ stdout: '', stderr: '', code: 1 })
  })

  it('on a terminal prompt with the cwd', async () => {
    const client = await connect(await startHarness())
    const stream = await shell(client, 'xterm')
    const done = collect(stream)
    await readUntil(stream, 'mirage:/$ ')
    stream.write('mkdir -p /up && cd /up\r')
    await readUntil(stream, 'mirage:/up$ ')
    stream.write('exit 5\r')
    expect((await done).code).toBe(5)
  })

  it('interrupt the running line on Ctrl-C and leave $? at 130', async () => {
    const client = await connect(await startHarness())
    const stream = await shell(client, 'xterm')
    const done = collect(stream)
    await readUntil(stream, '$ ')
    const started = Date.now()
    stream.write('sleep 30\r')
    await new Promise((r) => setTimeout(r, 500))
    stream.write('\x03')
    await readUntil(stream, '^C')
    stream.write('echo status=$?\r')
    await readUntil(stream, 'status=130')
    stream.write('exit\r')
    await done
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('drop the half-typed line on Ctrl-C at the prompt', async () => {
    const client = await connect(await startHarness())
    const stream = await shell(client, 'xterm')
    const done = collect(stream)
    await readUntil(stream, '$ ')
    stream.write('echo never-run\x03')
    await readUntil(stream, '^C')
    stream.write('echo status=$?\r')
    await readUntil(stream, 'status=130')
    stream.write('echo ran\r')
    const seen = await readUntil(stream, 'ran\r\n')
    stream.write('exit\r')
    await done
    expect(seen).not.toContain('never-run\r\n')
    expect(seen).not.toContain('never-runecho')
  })

  it('end when the workspace is removed', async () => {
    const h = await startHarness()
    const client = await connect(h)
    const stream = await shell(client, null)
    const done = collect(stream)
    await h.registry.remove('demo')
    stream.write('echo hi\n')
    const run = await done
    expect(run.stderr).toContain('the workspace is gone')
  })
})

/**
 * A server channel double for a pty ssh2's client cannot ask for: input
 * goes in with `send`, and what the server writes collects in `seen`.
 */
class FakeTerminal extends PassThrough {
  seen = ''
  code: number | null = null
  readonly stderr = new PassThrough()
  private shown = 0

  send(text: string): void {
    this.emit('data', Buffer.from(text))
  }

  override write(chunk: Uint8Array | string): boolean {
    this.seen += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }

  exit(code: number): void {
    this.code = code
  }

  async until(needle: string): Promise<string> {
    for (let i = 0; i < 500; i++) {
      const fresh = this.seen.slice(this.shown)
      if (fresh.includes(needle)) {
        this.shown = this.seen.length
        return fresh
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`never saw ${JSON.stringify(needle)} in ${JSON.stringify(this.seen)}`)
  }

  asChannel(): ServerChannel {
    return this as unknown as ServerChannel
  }
}

describe('a pty without a terminal type', () => {
  it('prompts, echoes and takes Ctrl-C like any terminal', async () => {
    const registry = new WorkspaceRegistry({ idleGraceSeconds: 0 })
    registry.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'demo')
    const term = new FakeTerminal()
    const request = {
      username: 'demo',
      profile: [],
      account: [],
      command: null,
      term: '',
      peer: null,
      local: null,
    }
    const served = handleChannel(registry, term.asChannel(), request, () => undefined)
    await term.until('mirage:/$ ')
    term.send('sleep 30\r')
    await new Promise((resolve) => setTimeout(resolve, 500))
    term.send('\x03')
    await term.until('^C')
    term.send('echo status=$?\r')
    const seen = await term.until('status=130\r\n')
    term.send('exit\r')
    await served
    expect(seen).toContain('echo status=$?\r\n')
    expect(term.code).toBe(0)
  })
})

describe('subsystems', () => {
  it('other than sftp are refused', async () => {
    const client = await connect(await startHarness())
    const run = await new Promise<Run>((resolve, reject) => {
      client.subsys('netconf', (err, stream) => {
        if (err !== undefined) reject(err)
        else void collect(stream).then(resolve)
      })
    })
    expect(run).toEqual({ stdout: '', stderr: 'mirage: unsupported subsystem: netconf\n', code: 1 })
  })
})

it('closes sessions when login environment setup fails', async () => {
  const h = await startHarness()
  const spy = vi
    .spyOn(h.entry.runner.ws, 'shell')
    .mockRejectedValue(new Error('login export failed'))
  try {
    const client = await connect(h)
    for (let i = 0; i < 2; i++) {
      const result = await exec(client, 'echo never')
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('login export failed')
      expect(sshSessions(h)).toEqual([])
    }
  } finally {
    spy.mockRestore()
  }
})

it('refuses an oversized plain shell line without executing it', async () => {
  const client = await connect(await startHarness())
  const stream = await shell(client, null)
  const result = collect(stream)
  stream.write('echo never' + 'x'.repeat(1024 * 1024))
  expect(await result).toEqual({
    stdout: '',
    stderr: 'mirage: shell input line too long\n',
    code: 1,
  })
})

describe('key profiles', () => {
  it('run a key bound to a profile under it', async () => {
    const h = await startHarness(await vaultWorkspace())
    const guarded = bindKey(h, 'mirage-profile="guarded"')
    const unsealed = await exec(await connect(h), 'cat /vault/secret')
    const sealed = await exec(await connect(h, 'demo', guarded), 'cat /vault/secret')
    expect(unsealed.stdout).toBe('token\n')
    expect(sealed.code).toBe(1)
    expect(sealed.stderr).toContain('the vault is sealed')
  })

  it.each([
    ['mirage-profile="nope"', 'nope'],
    ['mirage-profile="a",mirage-profile="b"', 'exactly one profile'],
    ['mirage-profile=""', 'exactly one profile'],
    ['mirage-profile', 'exactly one profile'],
  ])('refuse a key carrying %s', async (options, reason) => {
    const h = await startHarness(await vaultWorkspace())
    const bad = bindKey(h, options)
    const run = await exec(await connect(h, 'demo', bad), 'echo never')
    expect(run.code).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('cannot open a session')
    expect(run.stderr).toContain(reason)
  })
})

describe('key accounts', () => {
  /** The error a fresh SFTP channel answers its first listing with. */
  function sftpListError(client: Client): Promise<{ code?: number }> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err !== undefined) {
          reject(err)
          return
        }
        sftp.readdir('/', (listErr) => {
          resolve((listErr ?? {}) as { code?: number })
        })
      })
    })
  }

  it('open only the workspaces the account owns', async () => {
    const h = await startHarness()
    h.registry.add(new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }), 'mine', 'alice')
    const alice = bindKey(h, 'mirage-account="alice"')
    const own = await exec(await connect(h, 'mine', alice), 'echo mine')
    const otherClient = await connect(h, 'demo', alice)
    const other = await exec(otherClient, 'echo never')
    const listing = await sftpListError(otherClient)
    const admin = await exec(await connect(h, 'mine'), 'echo admin')
    expect(own.stdout).toBe('mine\n')
    expect(other).toEqual({ stdout: '', stderr: 'mirage: no such workspace: demo\n', code: 1 })
    expect(listing.code).toBe(2)
    expect(admin.stdout).toBe('admin\n')
  })

  it('refuse a key without one when accounts are required', async () => {
    const h = await startHarness()
    h.registry.accountsRequired = true
    expect(await exec(await connect(h), 'echo never')).toEqual({
      stdout: '',
      stderr: 'mirage: no such workspace: demo\n',
      code: 1,
    })
  })
})
