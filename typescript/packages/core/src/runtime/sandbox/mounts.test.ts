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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { MountType, RunResult, SandboxPipe } from '../types.ts'
import { RemoteSandbox } from './base.ts'
import { SSHFS_OPTIONS } from './constants.ts'
import { mountTable, registerPipeServer, topPrefixes } from './mounts.ts'

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

  constructor(
    mountType: MountType,
    own: readonly string[] = [],
    private readonly sshfs = true,
  ) {
    super({ captures: ['python3'] })
    for (const prefix of own) this.table.set(prefix, 'tmpfs')
    this.serveMounts(mountType)
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  execLine(line: string): Promise<RunResult> {
    this.commands.push(line)
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
    if (line.startsWith('fusermount3 -uz ')) this.table.delete(words(line)[2] ?? '')
    return Promise.resolve({ stdout: ENC.encode('ran\n'), stderr: null, exitCode: 0 })
  }

  override openPipe(command: string): Promise<SandboxPipe> {
    this.pipes.push(command)
    this.table.set(words(command)[6] ?? '', 'fuse.sshfs')
    let end: () => void = () => undefined
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        end = () => {
          controller.close()
        }
      },
    })
    return Promise.resolve({
      reader,
      writer: { write: () => undefined, end: () => undefined },
      stop: () => {
        end()
        return Promise.resolve()
      },
    })
  }
}

async function workspace(sandbox: FakeSandbox, hide: string[] = []): Promise<Workspace> {
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
      profiles: { agent: { paths: { hide } } },
      runtimes: [sandbox, 'workspace'],
    },
  )
}

beforeAll(() => {
  registerPipeServer(async (_files, _session, reader) => {
    const chunks = reader.getReader()
    while (!(await chunks.read()).done) continue
  })
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

  it('serves over both what the sandbox does not mount itself', async () => {
    const sandbox = new FakeSandbox('both', ['/data'])
    const ws = await workspace(sandbox, ['/my notes/secret'])
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.pipes.map((p) => words(p)[6])).toEqual(['/my notes'])
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
        "fake: /data is served by the sandbox itself, out of reach of this session's rules\n",
      )
      expect(sandbox.commands).not.toContain('python3 job.py')
      await ws.close()
    },
  )

  it('takes any session while the host serves nothing', async () => {
    const sandbox = new FakeSandbox('fuse', ['/data'])
    const ws = await workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect((await other.shell('python3 job.py')).exitCode).toBe(0)
    await ws.close()
  })

  it('serves nothing from the host over fuse', async () => {
    const sandbox = new FakeSandbox('fuse', ['/data'])
    const ws = await workspace(sandbox, ['/my notes/secret'])
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
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
      'fake: serving the workspace into a sandbox needs sshfs there; ' +
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
})
