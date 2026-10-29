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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MountMode } from '../../types.ts'
import type { PathSpec } from '../../types.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { Workspace } from '../workspace/workspace.ts'

const objects = new Map<string, Uint8Array>()

vi.mock('../../core/s3/write.ts', () => ({
  write: (accessor: { config: S3Config }, path: PathSpec, data: Uint8Array) => {
    objects.set(`${accessor.config.bucket}${path.virtual}`, data)
    return Promise.resolve()
  },
}))

vi.mock('../../core/s3/read.ts', () => ({
  read: (accessor: { config: S3Config }, path: PathSpec, options: { size?: number } = {}) => {
    const data = objects.get(`${accessor.config.bucket}${path.virtual}`)
    if (data === undefined)
      return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    return Promise.resolve(options.size === undefined ? data : data.subarray(0, options.size))
  },
}))

const STORE: S3Config = { bucket: 'snaps', region: 'us-east-1' }

async function written(): Promise<Workspace> {
  const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.dispatch('write', '/f', [new TextEncoder().encode('kept\n')])
  return ws
}

async function cat(ws: Workspace): Promise<string> {
  const value = (await ws.dispatch('read', '/f')) as Uint8Array | AsyncIterable<Uint8Array>
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  let text = ''
  for await (const chunk of value) text += new TextDecoder().decode(chunk)
  return text
}

afterEach(() => {
  objects.clear()
})

describe('Workspace.snapshot', () => {
  it('keeps stored input and expanded archive limits independent', async () => {
    const ws = await written()
    try {
      await ws.snapshot('limits.tar', { s3: STORE })
      const data = objects.get('snaps/limits.tar')
      if (data === undefined) throw new Error('snapshot was not stored')
      const restored = await Workspace.load('limits.tar', {
        s3: STORE,
        maxSnapshotBytes: data.byteLength,
        maxSnapshotEncodedBytes: data.byteLength,
      })
      try {
        expect(await cat(restored)).toBe('kept\n')
      } finally {
        await restored.close()
      }
      await expect(
        Workspace.load('limits.tar', {
          s3: STORE,
          maxSnapshotBytes: data.byteLength,
          maxSnapshotEncodedBytes: data.byteLength - 1,
        }),
      ).rejects.toThrow('snapshot exceeds encoded size limit')
      await expect(
        Workspace.load('limits.tar', {
          s3: STORE,
          maxSnapshotBytes: 1,
          maxSnapshotEncodedBytes: data.byteLength,
        }),
      ).rejects.toThrow('snapshot exceeds expanded size limit')
    } finally {
      await ws.close()
    }
  })

  it('applies the load budget to stored snapshots', async () => {
    const ws = await written()
    try {
      await ws.snapshot('large.tar', { s3: STORE })
      await expect(Workspace.load('large.tar', { s3: STORE, maxSnapshotBytes: 1 })).rejects.toThrow(
        'snapshot exceeds expanded size limit',
      )
    } finally {
      await ws.close()
    }
  })

  it('round-trips through the bytes it answers', async () => {
    const tar = await (await written()).snapshot()
    expect(tar.byteLength).toBeGreaterThan(0)
    expect(await cat(await Workspace.load(tar))).toBe('kept\n')
  })

  it('round-trips through a key of an S3-like store', async () => {
    const size = await (await written()).snapshot('a.tar', { s3: STORE })
    expect(objects.get('snaps/a.tar')?.byteLength).toBe(size)
    expect(await cat(await Workspace.load('a.tar', { s3: STORE }))).toBe('kept\n')
  })

  // The root the workspace adds when nothing claims `/` keeps its files
  // and its mode, and stays the anchor, so patchNodeFs still leaves the
  // host its paths after a copy or a load. Mirrors python's test_snapshot.
  it('keeps the scratch root an anchor across a round trip', async () => {
    const src = new Workspace({ '/m': new RAMVFS() }, { mode: MountMode.WRITE })
    await src.dispatch('write', '/f', [new TextEncoder().encode('kept\n')])
    const tar = await src.snapshot()
    for (const dst of [await src.copy(), await Workspace.load(tar)]) {
      expect(dst.syntheticRoot).toBe(true)
      expect(await cat(dst)).toBe('kept\n')
      await dst.dispatch('write', '/g', [new TextEncoder().encode('more')])
    }
  })

  it.each([1024 * 1024, null])('keeps max_memory %s across a round trip', async (maxMemory) => {
    const src = new Workspace({ '/m': new RAMVFS() }, { maxMemory })
    const tar = await src.snapshot()
    for (const dst of [await src.copy(), await Workspace.load(tar)]) {
      expect(dst.registry.memory?.limit ?? null).toBe(maxMemory)
    }
  })

  it.each([false, { allow: ['10.0.0.0/8'] }])(
    'keeps network %o across a round trip',
    async (network) => {
      const src = new Workspace({ '/m': new RAMVFS() }, { network })
      const tar = await src.snapshot()
      for (const dst of [await src.copy(), await Workspace.load(tar)]) {
        expect(dst.network).toEqual(network)
        expect(dst.registry.network).not.toBeNull()
      }
    },
  )

  it('refuses a copy under another network that would share a live mount', async () => {
    class Live extends BaseVFS {
      override readonly name = 'live'
    }
    const src = new Workspace({ '/m': new RAMVFS(), '/live': new Live() })
    try {
      await expect(src.copy({ network: false })).rejects.toThrow(
        "copy: /live/ keep this workspace's connections",
      )
      const same = await src.copy({ network: true })
      await same.close()
    } finally {
      await src.close()
    }
  })

  it.each([
    [{ allow: ['a.example', 'B.example.'] }, { allow: ['b.example', 'a.example', 'a.example'] }],
    [false, { allow: [] }],
  ])('copies over a live mount under an equal network: %o', async (held, asked) => {
    class Live extends BaseVFS {
      override readonly name = 'live'
    }
    const src = new Workspace({ '/m': new RAMVFS(), '/live': new Live() }, { network: held })
    try {
      const copy = await src.copy({ network: asked })
      await copy.close()
    } finally {
      await src.close()
    }
  })

  it('narrows network on a copy that asks it', async () => {
    const src = new Workspace({ '/m': new RAMVFS() })
    const copy = await src.copy({ network: false })
    expect(copy.network).toBe(false)
    expect(copy.registry.network?.lets('', '127.0.0.1')).toBe(false)
  })

  it('copies a read-only scratch root read-only', async () => {
    const src = new Workspace({ '/m': new RAMVFS() }, { mode: MountMode.READ })
    const copy = await src.copy()
    expect(copy.syntheticRoot).toBe(true)
    expect(copy.registry.rootMount?.mode).toBe(MountMode.READ)
  })

  it('reports a missing key as not found', async () => {
    await expect(Workspace.load('nope.tar', { s3: STORE })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

it('preserves the I/O buffer limit through copy and snapshot', async () => {
  const ws = new Workspace({}, { io: { bufferBytes: 262144 }, runtimes: ['workspace'] })
  const copies: Workspace[] = []
  try {
    copies.push(await ws.copy())
    copies.push(await Workspace.load(await ws.snapshot()))
    for (const restored of copies) {
      expect(restored.io.bufferBytes).toBe(262144)
      expect(restored.registry.io).toBe(restored.io)
    }
  } finally {
    await Promise.all(copies.map((restored) => restored.close()))
    await ws.close()
  }
})

describe('a snapshot and a RAM capacity', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
  async function refused(ws: Workspace, path: string, text: string): Promise<string | undefined> {
    try {
      await ws.vfs.write(path, bytes(text))
    } catch (err) {
      return (err as { code?: string }).code
    }
    return undefined
  }

  it('round-trips a cap through copy and load', async () => {
    const src = new Workspace({ '/a': [new RAMVFS({ capacity: 10 }), MountMode.WRITE] })
    const tar = await src.snapshot()
    for (const dst of [await src.copy(), await Workspace.load(tar)]) {
      const vfs = dst.registry.mountForPrefix('/a/').vfs
      expect(vfs instanceof RAMVFS ? vfs.usage?.limit : undefined).toBe(10)
      await dst.vfs.write('/a/f', bytes('12345678'))
      expect(await refused(dst, '/a/g', '123')).toBe('EDQUOT')
      await dst.close()
    }
    await src.close()
  })

  it('takes an override with its own capacity', async () => {
    const src = new Workspace({ '/a': [new RAMVFS({ capacity: 10 }), MountMode.WRITE] })
    await src.vfs.write('/a/f', bytes('x'.repeat(8)))
    const tar = await src.snapshot()
    await src.close()
    const over = await Workspace.load(tar, {}, { '/a': new RAMVFS({ capacity: 1 }) })
    const uncapped = new RAMVFS()
    const free = await Workspace.load(tar, {}, { '/a': uncapped })
    expect((await over.vfs.read('/a/f')).byteLength).toBe(8)
    expect(await refused(over, '/a/g', '1')).toBe('EDQUOT')
    await free.vfs.write('/a/g', bytes('y'.repeat(100)))
    expect(uncapped.usage).toBeNull()
    await over.close()
    await free.close()
  })
})
