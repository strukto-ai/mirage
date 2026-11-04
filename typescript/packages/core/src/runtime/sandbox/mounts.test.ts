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

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  currentCaller,
  getAdmission,
  getCurrentSession,
  lineRunning,
} from '../../context/session_context.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Limit, MountMode } from '../../types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { ProfileMount } from '../../policy/profile.ts'
import type { SessionState } from '../../workspace/session/session.ts'
import { materialize, type ByteSource } from '../../io/types.ts'
import { shellJoin } from '../../shell/join.ts'
import type { MountType, OutputFn, RunResult, SandboxPipe } from '../types.ts'
import { RemoteSandbox } from './base.ts'
import { PIPE_TRANSPORT, type PipeTransport } from './mixin.ts'
import { SSHFS_OPTIONS } from './constants.ts'
import {
  mountTable,
  registerPipeServer,
  runningLine,
  topPrefixes,
  type PipeServer,
} from './mounts.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// sh -c's own reading of a single-quoted word, enough for these commands.
function words(command: string): string[] {
  return [...command.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '')
}

// The argv a sandbox runs, as the line the fakes answer.
function lineOf(argv: readonly string[]): string {
  return argv[0] === '/bin/sh' && argv[1] === '-c' ? (argv[2] ?? '') : shellJoin(argv)
}

class FakeSandbox extends RemoteSandbox implements PipeTransport {
  readonly [PIPE_TRANSPORT] = true as const
  readonly name = 'fake'
  table = new Map<string, [string, string]>()
  running = new Set<string>()
  readonly commands: string[] = []
  readonly pipes: string[] = []
  readonly ends = new Map<string, () => void>()
  readonly stopped: string[] = []
  failUnmount = false
  failTable = false
  failCheck = false
  hang = false

  constructor(
    mountType: MountType,
    own: readonly string[] = [],
    private readonly sshfs = true,
    private readonly sshfsMounts = true,
  ) {
    super({ captures: ['python3'], config: { mountType } })
    for (const prefix of own) this.table.set(prefix, ['tmpfs', 'tmpfs'])
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    _output: OutputFn | null,
    _errors: OutputFn | null,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const data = stdin === null ? null : await materialize(stdin)
    return this.execLine(lineOf(argv), data, env, cwd, signal)
  }

  override execLine(
    line: string,
    _stdin?: ByteSource | null,
    _env?: Record<string, string>,
    _cwd?: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    this.commands.push(line)
    if ((line === 'cat /proc/mounts' && this.hang) || line === 'python3 slow.py') {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    }
    if (line === 'cat /proc/mounts' && this.failTable) {
      return Promise.resolve({
        stdout: new Uint8Array(),
        stderr: ENC.encode('gone\n'),
        exitCode: 1,
      })
    }
    if (line === 'cat /proc/mounts') {
      const rows = [...this.table]
        .map(([p, [source, kind]]) => `${escaped(source)} ${escaped(p)} ${kind} rw 0 0\n`)
        .join('')
      return Promise.resolve({ stdout: ENC.encode(rows), stderr: null, exitCode: 0 })
    }
    if (line.startsWith('cat /proc/[0-9]*/cmdline') && this.failCheck) {
      return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 2 })
    }
    if (line.startsWith('cat /proc/[0-9]*/cmdline')) {
      const source = / S='([^']*)' /.exec(line)?.[1] ?? ''
      return Promise.resolve({
        stdout: new Uint8Array(),
        stderr: null,
        exitCode: this.running.has(source) ? 0 : 1,
      })
    }
    if (line === 'command -v sshfs') {
      return Promise.resolve({
        stdout: new Uint8Array(),
        stderr: null,
        exitCode: this.sshfs ? 0 : 1,
      })
    }
    if (line.startsWith('fusermount3 -uz ')) {
      if (this.failUnmount) return Promise.reject(new Error('the sandbox went away'))
      const prefix = words(line)[2] ?? ''
      const [source] = this.table.get(prefix) ?? ['']
      this.table.delete(prefix)
      this.running.delete(source)
    }
    return Promise.resolve({ stdout: ENC.encode('ran\n'), stderr: null, exitCode: 0 })
  }

  openPipe(command: string): Promise<SandboxPipe> {
    this.pipes.push(command)
    const source = words(command)[5] ?? ''
    const prefix = words(command)[6] ?? ''
    if (this.sshfsMounts) {
      this.table.set(prefix, [source, 'fuse.sshfs'])
      this.running.add(source)
    }
    let end: () => void = () => undefined
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true
        end = () => {
          if (open) controller.close()
          open = false
        }
      },
    })
    this.ends.set(prefix, end)
    return Promise.resolve({
      reader,
      writer: { write: () => undefined, end: () => undefined },
      stop: () => {
        this.stopped.push(prefix)
        end()
        return Promise.resolve()
      },
    })
  }

  served(): string[] {
    return this.pipes.map((p) => words(p)[6] ?? '')
  }

  /** End `prefix`'s server: its sshfs then unmounts itself. */
  sshfsExits(prefix: string): void {
    this.ends.get(prefix)?.()
    const [source] = this.table.get(prefix) ?? ['']
    this.table.delete(prefix)
    this.running.delete(source)
  }
}

function escaped(text: string): string {
  return text.replaceAll(' ', '\\040')
}

// Another workspace's runtime on the same sandbox.
function sharing(sandbox: FakeSandbox, mountType: MountType): FakeSandbox {
  const other = new FakeSandbox(mountType)
  other.table = sandbox.table
  other.running = sandbox.running
  return other
}

function workspace(
  sandbox: FakeSandbox,
  hide: string[] = [],
  mounts?: ReadonlyMap<string, ProfileMount>,
  commandLimits?: Record<string, Limit>,
): Workspace {
  return new Workspace(
    {
      '/': new RAMVFS(),
      '/data': new RAMVFS(),
      '/data/sub': new RAMVFS(),
      '/my notes': new RAMVFS(),
    },
    {
      mode: MountMode.WRITE,
      profiles: { agent: { paths: { hide }, ...(mounts === undefined ? {} : { mounts }) } },
      runtimes: [sandbox, 'workspace'],
      ...(commandLimits === undefined ? {} : { commandLimits }),
    },
  )
}

// Whether `run` runs a request with a line's write admission.
async function lentALine(run: (op: () => Promise<void>) => Promise<void>): Promise<boolean> {
  let stop: unknown = null
  await run(() => {
    stop = currentCaller().stop
    return Promise.resolve()
  })
  return stop !== null
}

async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 1000 && !ready(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  expect(ready()).toBe(true)
}

const sessions: SessionState[] = []

// A served prefix's server that reads its pipe to the end.
const drain = (_files: unknown, session: SessionState): PipeServer => ({
  async serve(reader) {
    sessions.push(session)
    const chunks = reader.getReader()
    while (!(await chunks.read()).done) continue
  },
  sync: () => Promise.resolve(),
})

beforeAll(() => {
  registerPipeServer(drain)
})

describe('mountTable', () => {
  it('unescapes paths and keeps the top entry', () => {
    const table = mountTable(
      'tmpfs /data tmpfs rw 0 0\n' +
        'mirage-ab:/data /data fuse.sshfs rw 0 0\n' +
        'mirage-ab:/my\\040notes /my\\040notes fuse.sshfs rw 0 0\n',
    )
    expect(Object.fromEntries(table)).toEqual({
      '/data': ['mirage-ab:/data', 'fuse.sshfs'],
      '/my notes': ['mirage-ab:/my notes', 'fuse.sshfs'],
    })
  })
})

describe('runningLine', () => {
  // A program carrying the source as an argument serves it, as sshfs does;
  // a shorter or another source is not it.
  it.skipIf(!existsSync('/proc/self'))('finds a program carrying the source', async () => {
    const program = spawn('/bin/sh', [
      '-c',
      'echo ready; while :; do sleep 1; done',
      'sh',
      'mirage-x:/my notes',
      'mirage-x:/new\nline',
    ])
    try {
      await new Promise<void>((resolve) => {
        program.stdout.once('data', () => {
          resolve()
        })
      })
      const codes = [
        'mirage-x:/my notes',
        'mirage-x:/new\nline',
        'mirage-x:/my',
        'mirage-x:/new',
        'mirage-y:/data',
      ].map(
        (source) => spawnSync('/bin/sh', ['-c', runningLine(source)], { timeout: 10_000 }).status,
      )
      expect(codes).toEqual([0, 0, 1, 1, 1])
    } finally {
      program.kill('SIGKILL')
    }
  })

  // With no process to read, the line cannot tell rather than answer that
  // nothing serves the source.
  it('cannot tell without a process list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-running-'))
    for (const tool of ['tr', 'awk']) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
      symlinkSync(found.stdout.trim(), join(dir, tool))
    }
    const done = spawnSync('/bin/sh', ['-c', runningLine('mirage-x:/data')], {
      env: { PATH: dir },
      timeout: 10_000,
    })
    expect(done.status).toBe(2)
  })
})

describe('topPrefixes', () => {
  it('leaves out the root, the devices and nested mounts', () => {
    const prefixes = ['/', '/dev/', '/data/', '/data/sub/', '/database/', '/a/b/']
    expect(topPrefixes(prefixes)).toEqual(['/a/b', '/data', '/database'])
  })
})

describe('SandboxMounts', () => {
  it('serves every prefix the session sees over ssh', async () => {
    const sandbox = new FakeSandbox('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'ran\n'])
    const name = (words(sandbox.pipes[0] ?? '')[5] ?? '').split(':')[0] ?? ''
    expect(name).toMatch(/^mirage-[0-9a-f]{32}$/)
    expect(sandbox.pipes.map((p) => p.split(' 2>')[0])).toEqual([
      `exec sshfs -f -o ${SSHFS_OPTIONS} '${name}:/data' '/data'`,
      `exec sshfs -f -o ${SSHFS_OPTIONS} '${name}:/my notes' '/my notes'`,
    ])
    await agent.shell('python3 again.py')
    expect(sandbox.pipes).toHaveLength(2)
    await ws.close()
    expect(sandbox.table.size).toBe(0)
  })

  it('refuses a second session rather than show it the first view', async () => {
    const sandbox = new FakeSandbox('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    const result = await other.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      "fake: this sandbox shows session agent's view of the workspace; " +
        'give session other a sandbox of its own\n',
    )
    await ws.close()
  })

  it('refuses a session made again under its id', async () => {
    const sandbox = new FakeSandbox('ssh')
    const ws = workspace(sandbox)
    let agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    await ws.closeSession('agent')
    agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      "fake: this sandbox shows an earlier session agent's view of the workspace; " +
        'give session agent a sandbox of its own\n',
    )
    expect(sandbox.pipes).toHaveLength(2)
    await ws.close()
  })

  it('refuses hidden unserved mounts without claiming the sandbox', async () => {
    const sandbox = new FakeSandbox('ssh')
    const ws = workspace(sandbox, ['/data', '/my notes'])
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(126)
    expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
    expect(sandbox.pipes).toEqual([])
    expect((await other.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.pipes).toHaveLength(2)
    await ws.close()
  })

  it('leaves the sandbox free after a line it refused', async () => {
    const sandbox = new FakeSandbox('both', ['/data', '/my notes'])
    const ws = workspace(sandbox, ['/data'])
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    expect((await agent.shell('python3 job.py')).exitCode).toBe(126)
    expect((await other.shell('python3 job.py')).exitCode).toBe(0)
    await ws.close()
  })

  it('serves over both what the sandbox does not mount itself', async () => {
    const sandbox = new FakeSandbox('both', ['/data'])
    const ws = workspace(sandbox, ['/my notes/secret'])
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/my notes'])
    await ws.close()
  })

  it.each(['both', 'fuse'] as const)(
    'refuses a line under %s while a rule covers a prefix the sandbox serves',
    async (mountType) => {
      const sandbox = new FakeSandbox(mountType, ['/data'])
      const ws = workspace(sandbox, ['/data/secret.csv'])
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('python3 job.py')
      expect(result.exitCode).toBe(126)
      expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
      expect(sandbox.commands).not.toContain('python3 job.py')
      await ws.close()
    },
  )

  it('refuses a line once the sandbox mounts a ruled prefix itself', async () => {
    const sandbox = new FakeSandbox('fuse')
    const ws = workspace(sandbox, ['/data/secret.csv'])
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(126)
    sandbox.table.set('/data', ['x', 'fuse'])
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(126)
    expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
    await ws.close()
  })

  it('serves nothing from the host over fuse and takes any session', async () => {
    const sandbox = new FakeSandbox('fuse', ['/data'])
    const ws = workspace(sandbox, ['/my notes/secret'])
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    expect((await agent.shell('python3 job.py')).exitCode).toBe(126)
    expect((await other.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.pipes).toEqual([])
    await ws.close()
  })

  it('fails loud in a sandbox without sshfs', async () => {
    const sandbox = new FakeSandbox('ssh', [], false)
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      'python3: fake: serving the workspace into a sandbox needs sshfs there; ' +
        'install it in the image (apt-get install sshfs)\n',
    )
    expect(sandbox.pipes).toEqual([])
    await ws.close()
  })

  it('drops a dead sshfs mount before serving', async () => {
    const sandbox = new FakeSandbox('ssh')
    sandbox.table.set('/data', ['mirage-gone:/data', 'fuse.sshfs'])
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    const drop = "fusermount3 -uz '/data' || fusermount -uz '/data'"
    expect(sandbox.commands.indexOf(drop)).toBeLessThan(
      sandbox.commands.indexOf(
        "mkdir -p '/data' 2>/dev/null || { sudo -n mkdir -p '/data' && " +
          `sudo -n chown "$(id -u):$(id -g)" '/data'; }`,
      ),
    )
    await ws.close()
  })

  const FOREIGN =
    'fake: another sshfs serves /data in this sandbox; give this workspace a sandbox of its own\n'

  it('lets a second workspace on the sandbox unmount nothing', async () => {
    const first = new FakeSandbox('ssh')
    const second = sharing(first, 'ssh')
    const [ws1, ws2] = [workspace(first), workspace(second)]
    const one = await ws1.session('agent', { profile: 'agent' })
    const two = await ws2.session('agent', { profile: 'agent' })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    const mounted = new Map(first.table)
    const result = await two.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(FOREIGN)
    expect(second.pipes).toEqual([])
    expect(first.table).toEqual(mounted)
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    await ws2.close()
    expect(first.table).toEqual(mounted)
    await ws1.close()
    expect(first.table.size).toBe(0)
  })

  it('leaves the mount that replaced an ended server when dropping it', async () => {
    const first = new FakeSandbox('ssh')
    const second = sharing(first, 'ssh')
    const [ws1, ws2] = [workspace(first), workspace(second)]
    const one = await ws1.session('agent', { profile: 'agent' })
    const two = await ws2.session('agent', { profile: 'agent' })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    first.sshfsExits('/data')
    first.sshfsExits('/my notes')
    await until(() => true)
    expect((await two.shell('python3 job.py')).exitCode).toBe(0)
    const mounted = new Map(first.table)
    for (let line = 0; line < 2; line++) {
      const result = await one.shell('python3 job.py')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toBe(FOREIGN)
    }
    expect(first.table).toEqual(mounted)
    await ws1.close()
    expect(first.table).toEqual(mounted)
    await ws2.close()
  })

  it('leaves the next line checking after a check that fails', async () => {
    const first = new FakeSandbox('ssh')
    const second = sharing(first, 'ssh')
    const [ws1, ws2] = [workspace(first), workspace(second)]
    const one = await ws1.session('agent', { profile: 'agent' })
    const two = await ws2.session('agent', { profile: 'agent' })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    first.sshfsExits('/data')
    first.sshfsExits('/my notes')
    expect((await two.shell('python3 job.py')).exitCode).toBe(0)
    first.failCheck = true
    const failed = await one.shell('python3 job.py')
    expect(failed.exitCode).toBe(1)
    expect(DEC.decode(failed.stderr)).toContain('cannot tell whether')
    first.failCheck = false
    const result = await one.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(FOREIGN)
    await ws1.close()
    await ws2.close()
  })

  it("takes no other workspace's sshfs for its own under both", async () => {
    const first = new FakeSandbox('ssh')
    const second = sharing(first, 'both')
    const [ws1, ws2] = [workspace(first), workspace(second)]
    const one = await ws1.session('agent', { profile: 'agent' })
    const two = await ws2.session('agent', { profile: 'agent' })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    const result = await two.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(FOREIGN)
    await ws2.close()
    await ws1.close()
  })

  it.each(['both', 'fuse'] as const)(
    'refuses a line under %s while a hidden mount is the sandbox own',
    async (mountType) => {
      const sandbox = new FakeSandbox(mountType, ['/data'])
      const ws = workspace(sandbox, ['/data'])
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('python3 job.py')
      expect(result.exitCode).toBe(126)
      expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
      await ws.close()
    },
  )

  it('refuses a line while a mode cap covers a prefix the sandbox serves', async () => {
    const sandbox = new FakeSandbox('both', ['/data'])
    const ws = workspace(sandbox, [], new Map([['/data/sub', { mode: MountMode.READ }]]))
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(126)
    expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
    await ws.close()
  })

  it.each(['both', 'fuse'] as const)(
    'refuses a shown read-only path on a sandbox-owned mount under %s',
    async (mountType) => {
      const sandbox = new FakeSandbox(mountType, ['/data'])
      const ws = workspace(sandbox)
      try {
        const agent = await ws.session('agent', {
          profile: { paths: { hide: [], show: [{ path: '/data/locked', mode: MountMode.READ }] } },
        })
        const result = await agent.shell('python3 job.py')
        expect(result.exitCode).toBe(126)
        expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
        expect(sandbox.commands).not.toContain('python3 job.py')
      } finally {
        await ws.close()
      }
    },
  )

  it('serves the live session to a line with its own cwd', async () => {
    sessions.length = 0
    const sandbox = new FakeSandbox('ssh')
    const ws = workspace(sandbox)
    await ws.session('agent', { profile: 'agent' })
    const result = await ws.shell('python3 job.py', { sessionId: 'agent', cwd: '/data' })
    expect(result.exitCode).toBe(0)
    expect(sessions).toHaveLength(2)
    for (const session of sessions) expect(session).toBe(ws.getSession('agent'))
    await ws.close()
  })

  it('runs a server outside the line that started it', async () => {
    const bound: unknown[] = []
    registerPipeServer((files, session) => ({
      ...drain(files, session),
      serve: async (reader) => {
        bound.push([getCurrentSession(), getAdmission(), lineRunning()])
        const chunks = reader.getReader()
        while (!(await chunks.read()).done) continue
      },
    }))
    try {
      const sandbox = new FakeSandbox('ssh')
      const ws = workspace(sandbox)
      const agent = await ws.session('agent', { profile: 'agent' })
      expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
      expect(bound).toEqual([
        [null, null, false],
        [null, null, false],
      ])
      await ws.close()
    } finally {
      registerPipeServer(drain)
    }
  })

  it('returns a line once every server has landed', async () => {
    // sshfs sends the close that lands a line's writes after the line has
    // ended, so the line lands them itself, one server at a time, outside
    // the line but with its write admission: a capture waiting for the
    // line lets those writes through. Served requests run on that
    // admission until the line has landed them, the line waits out the
    // ones still running, and none run on it after.
    const holds: (() => void)[] = []
    const landed: [boolean, boolean][] = []
    const runs: ((op: () => Promise<void>) => Promise<void>)[] = []
    registerPipeServer((files, session, run) => {
      runs.push(run)
      return {
        ...drain(files, session),
        sync: async () => {
          await new Promise<void>((resolve) => holds.push(resolve))
          await files.write('/data/landed.txt', 'x')
          landed.push([lineRunning(), await lentALine(run)])
        },
      }
    })
    try {
      const ws = workspace(new FakeSandbox('ssh'))
      const agent = await ws.session('agent', { profile: 'agent' })
      let done = false
      const line = agent.shell('python3 job.py').finally(() => {
        done = true
      })
      await until(() => holds.length === 1)
      const capture = ws.snapshot()
      await until(() => (ws as unknown as { capturing: boolean }).capturing)
      holds[0]?.()
      await until(() => holds.length === 2)
      expect(done).toBe(false)
      let still = (): void => undefined
      const borrowed = runs[0]?.(
        () =>
          new Promise<void>((resolve) => {
            still = resolve
          }),
      )
      holds[1]?.()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(done).toBe(false)
      still()
      expect((await line).exitCode).toBe(0)
      await capture
      await borrowed
      expect(landed).toEqual([
        [false, true],
        [false, true],
      ])
      expect(await Promise.all(runs.map(lentALine))).toEqual([false, false])
      await ws.close()
    } finally {
      registerPipeServer(drain)
    }
  })

  it('lands the writes of a line that times out', async () => {
    const synced: boolean[] = []
    registerPipeServer((files, session) => ({
      ...drain(files, session),
      sync: () => {
        synced.push(lineRunning())
        return Promise.resolve()
      },
    }))
    try {
      const ws = workspace(new FakeSandbox('ssh'), [], undefined, {
        '@line': new Limit({ timeoutSeconds: 0.05 }),
      })
      const agent = await ws.session('agent', { profile: 'agent' })
      expect((await agent.shell('python3 slow.py')).exitCode).toBe(124)
      expect(synced).toEqual([false, false])
      await ws.close()
    } finally {
      registerPipeServer(drain)
    }
  })

  it('fails loud on a mount of its own under a served prefix', async () => {
    const sandbox = new FakeSandbox('both', ['/data/sub'])
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      'python3: fake: the sandbox mounts /data/sub itself, and serving /data would cover it\n',
    )
    expect(sandbox.pipes).toEqual([])
    await ws.close()
  })

  it('serves a mount added later on the next line', async () => {
    const sandbox = new FakeSandbox('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    ws.addMount('/extra', new RAMVFS(), MountMode.WRITE)
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/extra'])
    await ws.close()
  })

  it('starts a server that ended again', async () => {
    const sandbox = new FakeSandbox('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.ends.get('/data')?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/data'])
    await ws.close()
  })

  it('stops a pipe whose unmount failed', async () => {
    const sandbox = new FakeSandbox('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.failUnmount = true
    await ws.close()
    expect(sandbox.stopped).toEqual(['/data', '/my notes'])
  })

  it('unmounts on close when the mount table cannot be read', async () => {
    const sandbox = new FakeSandbox('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.failTable = true
    await ws.close()
    expect(sandbox.table.size).toBe(0)
    expect(sandbox.stopped).toEqual(['/data', '/my notes'])
  })

  it('keeps pipe diagnostics when the guest goes away during a mount', async () => {
    class UnavailableSandbox extends FakeSandbox {
      override execLine(
        line: string,
        stdin: ByteSource | null,
        env: Record<string, string>,
        cwd: string,
      ) {
        if (this.pipes.length > 0 && line === 'cat /proc/mounts')
          return Promise.reject(new Error('guest unavailable'))
        return super.execLine(line, stdin, env, cwd)
      }

      override async openPipe(command: string) {
        const pipe = await super.openPipe(command)
        pipe.diagnostic = () => Promise.resolve('msb refused: sandbox is not running')
        return pipe
      }
    }
    const ws = workspace(new UnavailableSandbox('ssh', [], true, false))
    try {
      const result = await ws.shell('python3 job.py')
      expect(result.exitCode).toBe(1)
      const said = DEC.decode(result.stderr)
      expect(said).toContain('guest unavailable')
      expect(said).toContain('helper said: msb refused: sandbox is not running')
    } finally {
      await ws.close()
    }
  })

  it('says why a server that fails did', async () => {
    registerPipeServer((files, session) => ({
      ...drain(files, session),
      serve: () => Promise.reject(new Error('no server here')),
    }))
    try {
      const sandbox = new FakeSandbox('ssh', [], true, false)
      const ws = workspace(sandbox)
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('python3 job.py')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toContain('the SFTP server failed: no server here')
      await ws.close()
    } finally {
      registerPipeServer(drain)
    }
  })

  it('lets go of its setup when the line is aborted', async () => {
    const sandbox = new FakeSandbox('ssh')
    sandbox.hang = true
    const ws = workspace(sandbox)
    await ws.session('agent', { profile: 'agent' })
    const abort = new AbortController()
    const running = ws.shell('python3 job.py', { sessionId: 'agent', signal: abort.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    abort.abort()
    await expect(running).rejects.toThrow()
    sandbox.hang = false
    expect((await ws.shell('python3 job.py', { sessionId: 'agent' })).exitCode).toBe(0)
    await ws.close()
  })
})
