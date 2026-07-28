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

  // Base-machinery tests exercise provisioning, not the mount setup, so
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

function mountCmds(box: RecordingSandbox): string[] {
  return box.execs.map(([line]) => line).filter((line) => line.startsWith('mirage mount'))
}

describe('RemoteSandbox', () => {
  it('provisions on the first line and mounts once', async () => {
    const box = new RecordingSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      const io = await ws.execute('python3 x')
      expect(DEC.decode(io.stdout)).toBe('ran:python3 x')
      expect(box.created).toBe(1)
      expect(box.ownedSandbox).toBe(true)
      expect(box.sandboxId).toBe('sb-rec')
      expect(box.synced).toBe(1)
      await ws.execute('python3 x')
      expect(box.created).toBe(1)
      // The workspace mounts once at provision, not per line.
      expect(box.synced).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('mount issues mount add with the spec in the env', async () => {
    const box = new FuseSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      attachSpecs(box, { '/data': FAKE_SPEC })
      await ws.execute('python3 /data/train.py')
      const adds = box.execs.filter(([line]) => line.startsWith('mirage mount add'))
      expect(adds).toHaveLength(1)
      const [line, , env] = adds[0] ?? ['', null, {} as Record<string, string>, '']
      expect(line).toBe('mirage mount add /data --fuse /workspace/data')
      expect(JSON.parse(env.MIRAGE_MOUNT_SPEC ?? '')).toEqual(FAKE_SPEC)
      // The spec travels in the environment, never as a file.
      expect(Object.keys(box.files)).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('mount excludes system mounts and runs once', async () => {
    const box = new FuseSandbox({ captures: ['python3'] })
    const ws = await sandboxWorkspace(box)
    try {
      attachSpecs(box, { '/data': FAKE_SPEC })
      await ws.execute('python3 x')
      await ws.execute('python3 x')
      // One add for /data at provision, nothing for /dev or the
      // history view, and no mount work on later lines.
      expect(mountCmds(box)).toEqual(['mirage mount add /data --fuse /workspace/data'])
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
      expect(mountCmds(box)).toEqual(['mirage mount add / --fuse /workspace'])
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

  it('mount failure points at the image', async () => {
    class FailingMountSandbox extends FuseSandbox {
      override execLine(
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ): Promise<RunResult> {
        if (line.startsWith('mirage mount')) {
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
