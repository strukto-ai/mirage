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
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../workspace.ts'
import { RemoteSandbox, type MountSpecs, type RemoteSandboxOptions } from './sandbox.ts'
import type { BridgeDispatchFn } from './python/mirage_bridge.ts'
import type { RunResult } from './runtime.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const FAKE_SPEC = { resource: 's3', config: { bucket: 'b' } }

class RecordingSandbox extends RemoteSandbox {
  readonly name = 'recbox'
  readonly files: Record<string, Uint8Array> = {}
  readonly execs: [string, Uint8Array | null, Record<string, string>, string][] = []
  created = 0
  connected: string[] = []
  mounted = false
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

  createSandbox(): Promise<string> {
    this.created += 1
    return Promise.resolve('sb-rec')
  }

  connectSandbox(sandboxId: string): Promise<void> {
    this.connected.push(sandboxId)
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

  upload(path: string, data: Uint8Array): Promise<void> {
    this.files[path] = data
    return Promise.resolve()
  }

  download(path: string): Promise<Uint8Array> {
    return Promise.resolve(this.files[path] ?? new Uint8Array())
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  // Base-machinery tests exercise provisioning, not the FUSE mount, so
  // record the mount call and skip the real one; FuseSandbox restores it.
  override mountWorkspace(): Promise<void> {
    this.mounted = true
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
  box.attach(attached[0], attached[1], () => specs)
}

describe('RemoteSandbox', () => {
  it('provisions on the first line and mounts the workspace', async () => {
    const box = new RecordingSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      const io = await ws.execute('python3 x')
      expect(DEC.decode(io.stdout)).toBe('ran:python3 x')
      expect(box.created).toBe(1)
      expect(box.ownedSandbox).toBe(true)
      expect(box.sandboxId).toBe('sb-rec')
      expect(box.mounted).toBe(true)
      await ws.execute('python3 x')
      expect(box.created).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('fuse config excludes system mounts', async () => {
    const box = new FuseSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      attachSpecs(box, { '/data': FAKE_SPEC })
      await ws.execute('python3 x')
      const config = JSON.parse(DEC.decode(box.files['/.mirage-workspace.json'])) as {
        mounts: Record<string, unknown>
      }
      expect(Object.keys(config.mounts)).toEqual(['/data'])
      for (const m of Object.keys(config.mounts)) {
        expect(m).not.toContain('/dev')
        expect(m).not.toContain('bash_history')
      }
    } finally {
      await ws.close()
    }
  })

  it('mounts a root-only workspace from root', async () => {
    const box = new FuseSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box, { '/': new RAMResource() })
    try {
      attachSpecs(box, { '/': FAKE_SPEC })
      await ws.execute('python3 x')
      const config = JSON.parse(DEC.decode(box.files['/.mirage-workspace.json'])) as {
        mounts: Record<string, unknown>
      }
      expect(Object.keys(config.mounts)).toEqual(['/'])
    } finally {
      await ws.close()
    }
  })

  it('resolves cwd under workspaceRoot and merges env', async () => {
    const box = new RecordingSandbox({ captures: ['*'], env: { BASE: '1' } })
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

  it('reattaches by sandboxId instead of creating', async () => {
    const box = new RecordingSandbox({ captures: ['python3'], sandboxId: 'sb-live' })
    const ws = await sandboxWorkspace(box)
    try {
      await ws.execute('python3 x')
      expect(box.created).toBe(0)
      expect(box.connected).toEqual(['sb-live'])
      expect(box.ownedSandbox).toBe(false)
      expect(box.sandboxId).toBe('sb-live')
    } finally {
      await ws.close()
    }
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

  it('fuse mode runs mirage workspace create', async () => {
    const box = new FuseSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      attachSpecs(box, { '/data': FAKE_SPEC })
      await ws.execute('python3 /data/train.py')
      // No tree upload: the only file is the standard workspace
      // config, declaring each mount with its live fuse target.
      expect(Object.keys(box.files)).toEqual(['/.mirage-workspace.json'])
      const config = JSON.parse(DEC.decode(box.files['/.mirage-workspace.json'])) as {
        mode: string
        mounts: Record<string, unknown>
      }
      expect(config.mode).toBe('exec')
      expect(config.mounts).toEqual({ '/data': { ...FAKE_SPEC, fuse: '/workspace/data' } })
      const created = box.execs.filter(
        ([line]) => line === 'mirage workspace create /.mirage-workspace.json',
      )
      expect(created).toHaveLength(1)
    } finally {
      await ws.close()
    }
  })

  it('fuse mount failure points at the image', async () => {
    class FailingCreateSandbox extends FuseSandbox {
      override execLine(
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ): Promise<RunResult> {
        if (line.startsWith('mirage workspace create')) {
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
    const box = new FailingCreateSandbox({ captures: ['python3'] })
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

  it('fuse mode rejects unmountable mounts', async () => {
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
