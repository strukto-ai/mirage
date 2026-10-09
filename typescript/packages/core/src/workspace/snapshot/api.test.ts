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
  read: (accessor: { config: S3Config }, path: PathSpec) => {
    const data = objects.get(`${accessor.config.bucket}${path.virtual}`)
    if (data === undefined)
      return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    return Promise.resolve(data)
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
