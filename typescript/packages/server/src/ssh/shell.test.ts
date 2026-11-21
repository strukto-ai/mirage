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

import { PassThrough } from 'node:stream'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import type { ClientChannel, ServerChannel } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceRegistry } from '../registry.ts'
import {
  closeHarnesses,
  collect,
  connect,
  exec,
  openShell,
  readUntil,
  sshSessions,
  startHarness,
  type Harness,
  type Run,
} from './harness.ts'
import { endsShell, handleChannel } from './shell.ts'

afterEach(closeHarnesses)

async function untilSessionsClose(h: Harness): Promise<void> {
  const started = Date.now()
  while (sshSessions(h).length > 0) {
    expect(Date.now() - started).toBeLessThan(10_000)
    await new Promise((r) => setTimeout(r, 100))
  }
}

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

  it('are recorded in history, the login line is not', async () => {
    const client = await connect(await startHarness())
    const stream = await openShell(client, null)
    const history = (await collect(stream, 'echo remembered\ncat /.bash_history\nexit\n')).stdout
    expect(history).toContain('echo remembered')
    expect(history).not.toContain('export HOME')
  })

  it('are hung up when a terminal drops', async () => {
    const h = await startHarness()
    const client = await connect(h)
    client.exec('sleep 30', { pty: true }, () => undefined)
    await new Promise((r) => setTimeout(r, 300))
    client.end()
    await untilSessionsClose(h)
  })

  it('are hung up when a terminal drops with input left unread', async () => {
    const h = await startHarness()
    const client = await connect(h)
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.exec('sleep 30', { pty: true }, (err, opened) => {
        if (err !== undefined) reject(err)
        else resolve(opened)
      })
    })
    for (let i = 0; i < 500 && sshSessions(h).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(sshSessions(h)).toHaveLength(1)
    stream.write('a'.repeat(3 * 1024 * 1024))
    await new Promise((r) => setTimeout(r, 500))
    ;(client as unknown as { _sock: { destroy(): void } })._sock.destroy()
    await untilSessionsClose(h)
  })

  it('run on after a drop without a terminal', async () => {
    const h = await startHarness()
    const client = await connect(h)
    client.exec('sleep 1; echo done > /ran', () => undefined)
    await new Promise((r) => setTimeout(r, 300))
    client.end()
    await untilSessionsClose(h)
    expect((await exec(await connect(h), 'cat /ran')).stdout).toBe('done\n')
  })

  it('without a terminal are hung up when they write after a drop', async () => {
    const h = await startHarness()
    const client = await connect(h)
    client.exec('sleep 1; echo out; sleep 30; touch /never', () => undefined)
    await new Promise((r) => setTimeout(r, 300))
    client.end()
    await untilSessionsClose(h)
    expect((await exec(await connect(h), 'ls /never')).code).not.toBe(0)
  })
})

describe('shell channels', () => {
  it('without a terminal run lines until exit', async () => {
    const client = await connect(await startHarness())
    const stream = await openShell(client, null)
    expect(await collect(stream, 'cd /\necho in\nexit 4\necho never\n')).toEqual({
      stdout: 'in\n',
      stderr: '',
      code: 4,
    })
  })

  it('without a terminal end at end of input', async () => {
    const client = await connect(await startHarness())
    const stream = await openShell(client, null)
    expect(await collect(stream, 'false\n')).toEqual({ stdout: '', stderr: '', code: 1 })
  })

  it('on a terminal prompt with the cwd', async () => {
    const client = await connect(await startHarness())
    const stream = await openShell(client, 'xterm')
    const done = collect(stream)
    await readUntil(stream, 'mirage:/$ ')
    stream.write('mkdir -p /up && cd /up\r')
    await readUntil(stream, 'mirage:/up$ ')
    stream.write('exit 5\r')
    expect((await done).code).toBe(5)
  })

  it('interrupt the running line on Ctrl-C and leave $? at 130', async () => {
    const client = await connect(await startHarness())
    const stream = await openShell(client, 'xterm')
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
    const stream = await openShell(client, 'xterm')
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
    const stream = await openShell(client, null)
    const done = collect(stream)
    stream.write('echo ready\n')
    await readUntil(stream, 'ready\n')
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
      env: {},
      peer: null,
      local: null,
      gone: new AbortController().signal,
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

it('refuses an oversized plain shell line without executing it', async () => {
  const client = await connect(await startHarness())
  const stream = await openShell(client, null)
  const result = collect(stream)
  stream.write('echo never' + 'x'.repeat(1024 * 1024))
  expect(await result).toEqual({
    stdout: '',
    stderr: 'mirage: shell input line too long\n',
    code: 1,
  })
})
