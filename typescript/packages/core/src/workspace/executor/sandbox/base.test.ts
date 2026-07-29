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
import { getTestParser } from '../../fixtures/workspace_fixture.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { Workspace } from '../../workspace.ts'
import { RemoteSandbox, type MountSpecs, type RemoteSandboxOptions } from './base.ts'
import type { BridgeDispatchFn } from '../python/mirage_bridge.ts'
import type { RunResult } from '../runtime.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const FAKE_SPEC = { resource: 's3', config: { bucket: 'b' } }

const CREATE_LINE =
  'mirage workspace delete sandbox >/dev/null 2>&1; ' +
  'mirage workspace create --id sandbox --from-env'

class RecordingSandbox extends RemoteSandbox {
  readonly name = 'recbox'
  readonly execs: [string, Uint8Array | null, Record<string, string>, string][] = []
  connectedCount = 0
  synced = 0
  attached: [BridgeDispatchFn, () => string[], (() => MountSpecs) | undefined] | null = null

  constructor(options: RemoteSandboxOptions = {}) {
    super(options)
  }

  override attach(
    dispatch: BridgeDispatchFn,
    listMounts: () => string[],
    listMountSpecs?: () => MountSpecs,
  ): void {
    super.attach(dispatch, listMounts, listMountSpecs)
    this.attached = [dispatch, listMounts, listMountSpecs]
  }

  connect(): Promise<void> {
    this.connectedCount += 1
    return Promise.resolve()
  }

  execLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    this.execs.push([line, stdin, env, cwd])
    return Promise.resolve({ stdout: ENC.encode(`ran:${line}`), stderr: null, exitCode: 0 })
  }

  // Base-machinery tests exercise connection, not the mount setup, so
  // record the call and skip the real one; FuseSandbox restores it.
  override mountWorkspace(): Promise<void> {
    this.synced += 1
    return Promise.resolve()
  }
}

class FuseSandbox extends RecordingSandbox {
  override mountWorkspace(): Promise<void> {
    return RemoteSandbox.prototype.mountWorkspace.call(this)
  }
}

async function sandboxWorkspace(
  box: RecordingSandbox,
  mounts: Record<string, RAMResource> = { '/data': new RAMResource() },
): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(mounts, {
    mode: MountMode.EXEC,
    shellParser: parser,
    runtimes: [box, 'vfs'],
  })
}

function attachSpecs(box: RecordingSandbox, specs: MountSpecs): void {
  const attached = box.attached
  if (attached === null) throw new Error('box not attached')
  box.attach(attached[0], attached[1], () => ({ ...specs }))
}

function createCalls(box: RecordingSandbox): Record<string, unknown>[] {
  return box.execs
    .filter(([line]) => line === CREATE_LINE)
    .map(([, , env]) => JSON.parse(env.MIRAGE_WORKSPACE_CONFIG ?? '{}') as Record<string, unknown>)
}

describe('RemoteSandbox', () => {
  it('connects on the first line and mounts once', async () => {
    const box = new RecordingSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      const io = await ws.execute('python3 x')
      expect(DEC.decode(io.stdout)).toBe('ran:python3 x')
      expect(box.connectedCount).toBe(1)
      expect(box.synced).toBe(1)
      await ws.execute('python3 x')
      // The workspace mounts once on the first line, not per line.
      expect(box.connectedCount).toBe(1)
      expect(box.synced).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('mount creates one workspace with the config in the env', async () => {
    const box = new FuseSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      attachSpecs(box, { '/data': FAKE_SPEC })
      await ws.execute('python3 /data/train.py')
      const configs = createCalls(box)
      expect(configs).toHaveLength(1)
      expect(configs[0]).toEqual({
        mode: 'EXEC',
        mounts: { '/data': { ...FAKE_SPEC, fuse: '/workspace/data' } },
      })
    } finally {
      await ws.close()
    }
  })

  it('mount excludes system mounts and runs once', async () => {
    const box = new FuseSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      attachSpecs(box, { '/data': FAKE_SPEC, '/dev': null })
      await ws.execute('python3 x')
      await ws.execute('python3 x')
      const configs = createCalls(box)
      // One workspace create at first line, /dev never reproduced,
      // and no mount work on later lines.
      expect(configs).toHaveLength(1)
      expect(Object.keys((configs[0]?.mounts ?? {}) as Record<string, unknown>)).toEqual(['/data'])
    } finally {
      await ws.close()
    }
  })

  it('mounts a root-only workspace at the root', async () => {
    const box = new FuseSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box, { '/': new RAMResource() })
    try {
      attachSpecs(box, { '/': FAKE_SPEC })
      await ws.execute('python3 x')
      const configs = createCalls(box)
      const mounts = (configs[0]?.mounts ?? {}) as Record<string, Record<string, unknown>>
      expect(mounts['/']?.fuse).toBe('/workspace')
    } finally {
      await ws.close()
    }
  })

  it('resolves cwd under workspaceRoot and merges env', async () => {
    const box = new RecordingSandbox({ captures: ['*'], config: { env: { BASE: '1' } } })
    const ws = await sandboxWorkspace(box)
    try {
      const result = await box.runLine('nvidia-smi', null, { LINE: '2' }, '/data/deep')
      expect(result.exitCode).toBe(0)
      const [, , env, cwd] = box.execs[box.execs.length - 1] ?? [
        '',
        null,
        {} as Record<string, string>,
        '',
      ]
      expect(cwd).toBe('/workspace/data/deep')
      expect(env.BASE).toBe('1')
      expect(env.LINE).toBe('2')
    } finally {
      await ws.close()
    }
  })

  it('a custom workspaceRoot rebases the cwd', async () => {
    const box = new RecordingSandbox({ captures: ['*'], workspaceRoot: '/home/daytona/workspace' })
    const result = await box.runLine('ls', null, {}, '/data')
    expect(result.exitCode).toBe(0)
    const [, , , cwd] = box.execs[box.execs.length - 1] ?? ['', null, {}, '']
    expect(cwd).toBe('/home/daytona/workspace/data')
  })

  it('passes stdin bytes through to execLine', async () => {
    const box = new RecordingSandbox({ captures: ['*'] })
    const ws = await sandboxWorkspace(box)
    try {
      await ws.execute('wc -l', { stdin: ENC.encode('a\nb\n') })
      const [, stdin] = box.execs[box.execs.length - 1] ?? ['', null, {}, '']
      expect(DEC.decode(stdin ?? new Uint8Array())).toBe('a\nb\n')
    } finally {
      await ws.close()
    }
  })

  it('rejects run(): sandboxes take whole lines', async () => {
    const box = new RecordingSandbox()
    await expect(box.run({ code: 'x', args: [], env: {}, stdin: null })).rejects.toThrow(
      'whole lines',
    )
  })

  it('rejects unknown config keys', () => {
    const options = { config: { snapshot: 'mirage-fuse' } } as Record<string, unknown>
    expect(() => new RecordingSandbox(options)).toThrow("unknown sandbox config key 'snapshot'")
  })

  it('mount failure points at the image', async () => {
    class FailingMountSandbox extends FuseSandbox {
      override execLine(
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ): Promise<RunResult> {
        if (line.startsWith('mirage workspace')) {
          this.execs.push([line, stdin, env, cwd])
          return Promise.resolve({
            stdout: new Uint8Array(),
            stderr: ENC.encode('mirage: command not found'),
            exitCode: 127,
          })
        }
        return super.execLine(line, stdin, env, cwd)
      }
    }
    const box = new FailingMountSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      attachSpecs(box, { '/data': { resource: 's3', config: {} } })
      const io = await ws.execute('python3 x')
      expect(io.exitCode).not.toBe(0)
      expect(DEC.decode(io.stderr)).toContain('mirage-python-fuse')
      expect(DEC.decode(io.stderr)).toContain('command not found')
    } finally {
      await ws.close()
    }
  })

  it('mount rejects unmountable mounts', async () => {
    const box = new FuseSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      const io = await ws.execute('python3 x')
      expect(io.exitCode).not.toBe(0)
      expect(DEC.decode(io.stderr)).toContain('not remotely mountable')
    } finally {
      await ws.close()
    }
  })
})
