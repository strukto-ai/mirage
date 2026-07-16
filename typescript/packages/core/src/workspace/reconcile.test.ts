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
import { RAMResource } from '../resource/ram/ram.ts'
import { ConsistencyPolicy } from '../types.ts'
import type { MountEntry } from './mount/mount.ts'
import { Reconciler } from './reconcile.ts'
import { Workspace } from './workspace.ts'

function enoent(path: string): Error {
  return Object.assign(new Error(path), { code: 'ENOENT' })
}

function mountOf(ws: Workspace, path: string): MountEntry {
  const m = ws.namespace.mountFor(path)
  if (m === null) throw new Error(`no mount for ${path}`)
  return m
}

async function wsWithOverlay(): Promise<Workspace> {
  const ws = new Workspace({ '/data': new RAMResource() })
  await ws.namespace.ensureLoaded()
  await ws.namespace.setAttrs('/data/f.txt', { mode: 0o600 })
  return ws
}

describe('Reconciler', () => {
  it('onOpMissing GCs an orphaned overlay under ALWAYS + stat + ENOENT', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace, ws.ops, ConsistencyPolicy.ALWAYS)
    await rec.onOpMissing('stat', '/data/f.txt', enoent('/data/f.txt'))
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()
    await ws.close()
  })

  it('onOpMissing keeps an authoritative symlink', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.symlink('/data/link', '/data/t', 1)
    const rec = new Reconciler(ws.cache, ws.namespace, ws.ops, ConsistencyPolicy.ALWAYS)
    await rec.onOpMissing('stat', '/data/link', enoent('/data/link'))
    expect(ws.namespace.readlink('/data/link')).toBe('/data/t')
    await ws.close()
  })

  it('onOpMissing skips under LAZY', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace, ws.ops, ConsistencyPolicy.LAZY)
    await rec.onOpMissing('stat', '/data/f.txt', enoent('/data/f.txt'))
    expect(ws.namespace.metaFor('/data/f.txt')).not.toBeNull()
    await ws.close()
  })

  it('onOpMissing skips a non-revalidate op', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace, ws.ops, ConsistencyPolicy.ALWAYS)
    await rec.onOpMissing('write', '/data/f.txt', enoent('/data/f.txt'))
    expect(ws.namespace.metaFor('/data/f.txt')).not.toBeNull()
    await ws.close()
  })

  it('onOpMissing ignores a non-ENOENT error', async () => {
    const ws = await wsWithOverlay()
    const rec = new Reconciler(ws.cache, ws.namespace, ws.ops, ConsistencyPolicy.ALWAYS)
    await rec.onOpMissing('stat', '/data/f.txt', new Error('boom'))
    expect(ws.namespace.metaFor('/data/f.txt')).not.toBeNull()
    await ws.close()
  })

  it('mayServeCached trusts the cache under LAZY', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    const mount = mountOf(ws, '/data/f.txt')
    const rec = new Reconciler(ws.cache, ws.namespace, ws.ops, ConsistencyPolicy.LAZY)
    expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(true)
    await ws.close()
  })

  it('mayServeCached forces a re-read for a no-fingerprint backend under ALWAYS', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    const mount = mountOf(ws, '/data/f.txt')
    const rec = new Reconciler(ws.cache, ws.namespace, ws.ops, ConsistencyPolicy.ALWAYS)
    expect(await rec.mayServeCached(mount, '/data/f.txt')).toBe(false)
    await ws.close()
  })

  it('reconcileRead GCs an orphaned overlay when the backend reports gone', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
    const mount = mountOf(ws, '/data/gone.txt')
    const rec = new Reconciler(ws.cache, ws.namespace, ws.ops, ConsistencyPolicy.ALWAYS)
    await rec.reconcileRead(mount, '/data/gone.txt')
    expect(ws.namespace.metaFor('/data/gone.txt')).toBeNull()
    await ws.close()
  })

  it('reconcileRead is a no-op without an overlay or cached copy', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    const mount = mountOf(ws, '/data/plain.txt')
    const rec = new Reconciler(ws.cache, ws.namespace, ws.ops, ConsistencyPolicy.ALWAYS)
    await rec.reconcileRead(mount, '/data/plain.txt')
    await ws.close()
  })

  it('reconcileRead skips under LAZY', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    await ws.namespace.ensureLoaded()
    await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
    const mount = mountOf(ws, '/data/gone.txt')
    const rec = new Reconciler(ws.cache, ws.namespace, ws.ops, ConsistencyPolicy.LAZY)
    await rec.reconcileRead(mount, '/data/gone.txt')
    expect(ws.namespace.metaFor('/data/gone.txt')).not.toBeNull()
    await ws.close()
  })
})
