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

import { beforeAll, describe, expect, it } from 'vitest'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { getAdmission, getCurrentSession, lineRunning } from '../../context/session_context.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { ProfileMount } from '../../policy/profile.ts'
import type { SessionState } from '../../workspace/session/session.ts'
import type { MountType, RunResult, SandboxPipe } from '../types.ts'
import { RemoteSandbox } from './base.ts'
import { SSHFS_OPTIONS } from './constants.ts'
import { mountTable, registerPipeServer, topPrefixes, type PipeServer } from './mounts.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// sh -c's own reading of a single-quoted word, enough for these commands.
function words(command: string): string[] {
  return [...command.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '')
}

class FakeSandbox extends RemoteSandbox {
  readonly name = 'fake'
  readonly table = new Map<string, string>()
  readonly commands: string[] = []
  readonly pipes: string[] = []
  readonly ends = new Map<string, () => void>()
  readonly stopped: string[] = []
  failUnmount = false
  hang = false

  constructor(
    mountType: MountType,
    own: readonly string[] = [],
    private readonly sshfs = true,
    private readonly sshfsMounts = true,
  ) {
    super({ captures: ['python3'] })
    for (const prefix of own) this.table.set(prefix, 'tmpfs')
    this.serveMounts(mountType)
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  override execLine(
    line: string,
    _stdin?: Uint8Array | null,
    _env?: Record<string, string>,
    _cwd?: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    this.commands.push(line)
    if (line === 'cat /proc/mounts' && this.hang) {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    }
    if (line === 'cat /proc/mounts') {
      const rows = [...this.table]
        .map(([p, kind]) => `src ${p.replaceAll(' ', '\\040')} ${kind} rw 0 0\n`)
        .join('')
      return Promise.resolve({ stdout: ENC.encode(rows), stderr: null, exitCode: 0 })
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
      this.table.delete(words(line)[2] ?? '')
    }
    return Promise.resolve({ stdout: ENC.encode('ran\n'), stderr: null, exitCode: 0 })
  }

  override openPipe(command: string): Promise<SandboxPipe> {
    this.pipes.push(command)
    const prefix = words(command)[6] ?? ''
    if (this.sshfsMounts) this.table.set(prefix, 'fuse.sshfs')
    let end: () => void = () => undefined
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        end = () => {
          controller.close()
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
}

async function workspace(
  sandbox: FakeSandbox,
  hide: string[] = [],
  mounts?: ReadonlyMap<string, ProfileMount>,
): Promise<Workspace> {
  return new Workspace(
    {
      '/': new RAMVFS(),
      '/data': new RAMVFS(),
      '/data/sub': new RAMVFS(),
      '/my notes': new RAMVFS(),
    },
    {
      mode: MountMode.WRITE,
      shellParser: await getTestParser(),
      profiles: { agent: { paths: { hide }, ...(mounts === undefined ? {} : { mounts }) } },
      runtimes: [sandbox, 'workspace'],
    },
  )
}

const sessions: SessionState[] = []

const drain: PipeServer = async (_files, session, reader) => {
  sessions.push(session)
  const chunks = reader.getReader()
  while (!(await chunks.read()).done) continue
}

beforeAll(() => {
  registerPipeServer(drain)
})

describe('mountTable', () => {
  it('unescapes paths and keeps the top entry', () => {
    const table = mountTable(
      'tmpfs /data tmpfs rw 0 0\n' +
        'mirage:/data /data fuse.sshfs rw 0 0\n' +
        'x /my\\040notes tmpfs rw 0 0\n',
    )
    expect(Object.fromEntries(table)).toEqual({ '/data': 'fuse.sshfs', '/my notes': 'tmpfs' })
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
    const ws = await workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'ran\n'])
    expect(sandbox.pipes.map((p) => p.split(' 2>')[0])).toEqual([
      `exec sshfs -f -o ${SSHFS_OPTIONS} 'mirage:/data' '/data'`,
      `exec sshfs -f -o ${SSHFS_OPTIONS} 'mirage:/my notes' '/my notes'`,
    ])
    await agent.shell('python3 again.py')
    expect(sandbox.pipes).toHaveLength(2)
    await ws.close()
    expect(sandbox.table.size).toBe(0)
  })

  it('refuses a second session rather than show it the first view', async () => {
    const sandbox = new FakeSandbox('ssh')
    const ws = await workspace(sandbox)
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
    const ws = await workspace(sandbox)
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
    const ws = await workspace(sandbox, ['/data', '/my notes'])
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toContain('not served through the dispatcher')
    expect(sandbox.pipes).toEqual([])
    expect((await other.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.pipes).toHaveLength(2)
    await ws.close()
  })

  it('leaves the sandbox free after a line it refused', async () => {
    const sandbox = new FakeSandbox('both', ['/data', '/my notes'])
    const ws = await workspace(sandbox, ['/data'])
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    expect((await agent.shell('python3 job.py')).exitCode).toBe(1)
    expect((await other.shell('python3 job.py')).exitCode).toBe(0)
    await ws.close()
  })

  it('serves over both what the sandbox does not mount itself', async () => {
    const sandbox = new FakeSandbox('both', ['/data'])
    const ws = await workspace(sandbox, ['/my notes/secret'])
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/my notes'])
    await ws.close()
  })

  it.each(['both', 'fuse'] as const)(
    'refuses a line under %s while a rule covers a prefix the sandbox serves',
    async (mountType) => {
      const sandbox = new FakeSandbox(mountType, ['/data'])
      const ws = await workspace(sandbox, ['/data/secret.csv'])
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('python3 job.py')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toBe(
        "fake: /data is not served through the dispatcher, out of reach of this session's rules\n",
      )
      expect(sandbox.commands).not.toContain('python3 job.py')
      await ws.close()
    },
  )

  it('refuses a line once the sandbox mounts a ruled prefix itself', async () => {
    const sandbox = new FakeSandbox('fuse')
    const ws = await workspace(sandbox, ['/data/secret.csv'])
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(1)
    sandbox.table.set('/data', 'fuse')
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      "fake: /data is not served through the dispatcher, out of reach of this session's rules\n",
    )
    await ws.close()
  })

  it('serves nothing from the host over fuse and takes any session', async () => {
    const sandbox = new FakeSandbox('fuse', ['/data'])
    const ws = await workspace(sandbox, ['/my notes/secret'])
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    expect((await agent.shell('python3 job.py')).exitCode).toBe(1)
    expect((await other.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.pipes).toEqual([])
    await ws.close()
  })

  it('fails loud in a sandbox without sshfs', async () => {
    const sandbox = new FakeSandbox('ssh', [], false)
    const ws = await workspace(sandbox)
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

  it('drops a stale sshfs mount before serving', async () => {
    const sandbox = new FakeSandbox('ssh')
    sandbox.table.set('/data', 'fuse.sshfs')
    const ws = await workspace(sandbox)
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

  it.each(['both', 'fuse'] as const)(
    'refuses a line under %s while a hidden mount is the sandbox own',
    async (mountType) => {
      const sandbox = new FakeSandbox(mountType, ['/data'])
      const ws = await workspace(sandbox, ['/data'])
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('python3 job.py')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toBe(
        "fake: /data is not served through the dispatcher, out of reach of this session's rules\n",
      )
      await ws.close()
    },
  )

  it('refuses a line while a mode cap covers a prefix the sandbox serves', async () => {
    const sandbox = new FakeSandbox('both', ['/data'])
    const ws = await workspace(sandbox, [], new Map([['/data/sub', { mode: MountMode.READ }]]))
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toContain(
      'fake: /data/sub is not served through the dispatcher',
    )
    await ws.close()
  })

  it.each(['both', 'fuse'] as const)(
    'refuses a shown read-only path on a sandbox-owned mount under %s',
    async (mountType) => {
      const sandbox = new FakeSandbox(mountType, ['/data'])
      const ws = await workspace(sandbox)
      try {
        const agent = await ws.session('agent', {
          profile: { paths: { hide: [], show: [{ path: '/data/locked', mode: MountMode.READ }] } },
        })
        const result = await agent.shell('python3 job.py')
        expect(result.exitCode).toBe(1)
        expect(DEC.decode(result.stderr)).toContain('/data is not served through the dispatcher')
        expect(sandbox.commands).not.toContain('python3 job.py')
      } finally {
        await ws.close()
      }
    },
  )

  it('serves the live session to a line with its own cwd', async () => {
    sessions.length = 0
    const sandbox = new FakeSandbox('ssh')
    const ws = await workspace(sandbox)
    await ws.session('agent', { profile: 'agent' })
    const result = await ws.shell('python3 job.py', { sessionId: 'agent', cwd: '/data' })
    expect(result.exitCode).toBe(0)
    expect(sessions).toHaveLength(2)
    for (const session of sessions) expect(session).toBe(ws.getSession('agent'))
    await ws.close()
  })

  it('runs a server outside the line that started it', async () => {
    const bound: unknown[] = []
    registerPipeServer(async (_files, _session, reader) => {
      bound.push([getCurrentSession(), getAdmission(), lineRunning()])
      const chunks = reader.getReader()
      while (!(await chunks.read()).done) continue
    })
    try {
      const sandbox = new FakeSandbox('ssh')
      const ws = await workspace(sandbox)
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

  it('fails loud on a mount of its own under a served prefix', async () => {
    const sandbox = new FakeSandbox('both', ['/data/sub'])
    const ws = await workspace(sandbox)
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
    const ws = await workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    ws.addMount('/extra', new RAMVFS(), MountMode.WRITE)
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/extra'])
    await ws.close()
  })

  it('starts a server that ended again', async () => {
    const sandbox = new FakeSandbox('ssh')
    const ws = await workspace(sandbox)
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
    const ws = await workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.failUnmount = true
    await ws.close()
    expect(sandbox.stopped).toEqual(['/data', '/my notes'])
  })

  it('says why a server that fails did', async () => {
    registerPipeServer(() => Promise.reject(new Error('no server here')))
    try {
      const sandbox = new FakeSandbox('ssh', [], true, false)
      const ws = await workspace(sandbox)
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
    const ws = await workspace(sandbox)
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
