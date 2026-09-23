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
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { CycleError } from '../../../utils/path.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { metaFromFields, metaToFields } from './namespace.ts'
import { RAMNamespaceStore } from './ram.ts'

describe('Namespace facade (addressing)', () => {
  it('resolve delegates to the workspace resolver', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    const viaNs = await ws.namespace.resolve('/data/a.txt')
    const viaWs = await ws.resolve('/data/a.txt')
    expect(viaNs).toEqual(viaWs)
    await ws.close()
  })

  it('follow is a no-op without a symlink table', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    const withFollow = await ws.namespace.resolve('/data/a.txt', true)
    const noFollow = await ws.namespace.resolve('/data/a.txt', false)
    expect(withFollow).toEqual(noFollow)
    await ws.close()
  })

  it('mountFor returns the owning mount', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    const mount = ws.namespace.mountFor('/data/a.txt')
    expect(mount.prefix).toBe('/data/')
    await ws.close()
  })
})

describe('Namespace symlink table', () => {
  it('symlink/readlink round-trip verbatim', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/link', '/data/hello.txt', 1)
    expect(ws.namespace.isLink('/data/link')).toBe(true)
    expect(ws.namespace.readlink('/data/link')).toBe('/data/hello.txt')
    await ws.close()
  })

  it('readlink of a missing link returns null', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    expect(ws.namespace.readlink('/data/nope')).toBeNull()
    await ws.close()
  })

  it('stores a relative target verbatim', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/link', 'hello.txt', 1)
    expect(ws.namespace.readlink('/data/link')).toBe('hello.txt')
    await ws.close()
  })

  it('unlink removes the link', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/link', '/data/hello.txt', 1)
    expect(await ws.namespace.unlink('/data/link')).toBe(true)
    expect(ws.namespace.isLink('/data/link')).toBe(false)
    expect(await ws.namespace.unlink('/data/link')).toBe(false)
    await ws.close()
  })

  it('rename moves the link entry', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/a', '/data/hello.txt', 1)
    expect(await ws.namespace.rename('/data/a', '/data/b')).toBe(true)
    expect(ws.namespace.isLink('/data/a')).toBe(false)
    expect(ws.namespace.readlink('/data/b')).toBe('/data/hello.txt')
    await ws.close()
  })

  it('resolve follows a link to its target mount', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/link', '/data/hello.txt', 1)
    const viaLink = await ws.namespace.resolve('/data/link', true)
    const viaTarget = await ws.namespace.resolve('/data/hello.txt')
    expect(viaLink).toEqual(viaTarget)
    await ws.close()
  })

  it('resolve without follow keeps the link path', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/link', '/data/hello.txt', 1)
    const noFollow = await ws.namespace.resolve('/data/link', false)
    const [, spec] = noFollow
    expect(spec.virtual).toBe('/data/link')
    await ws.close()
  })

  it('resolve throws CycleError on a symlink loop', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/a', '/data/b', 1)
    await ws.namespace.symlink('/data/b', '/data/a', 1)
    await expect(ws.namespace.resolve('/data/a', true)).rejects.toThrow(CycleError)
    await ws.close()
  })

  it('follow resolves prefix links and is identity otherwise', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    expect(ws.namespace.follow('/data/x')).toBe('/data/x')
    await ws.namespace.symlink('/data/link', '/data/real', 1)
    expect(ws.namespace.follow('/data/link/f.txt')).toBe('/data/real/f.txt')
    expect(ws.namespace.follow('/data/other')).toBe('/data/other')
    await ws.close()
  })

  // What a readdir row's mark needs: the names, one level, no stats.
  it('linkNamesUnder is one level of names', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/a', '/t1', 1)
    await ws.namespace.symlink('/data/sub/b', '/t2', 1)
    expect(ws.namespace.linkNamesUnder('/data')).toEqual(new Set(['a']))
    expect(ws.namespace.linkNamesUnder('/other')).toEqual(new Set())
    await ws.close()
  })

  // A readdir of an alias is dispatched at its target and answers with
  // that directory's entries, so the marks come from there. Asking the
  // typed path left every link inside an aliased directory unmarked, and
  // a dir link inside it then read as a directory a walk recurses.
  it('linkNamesUnder answers for the directory a link names', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/real/lk', '/data/real/t.txt', 1)
    await ws.namespace.symlink('/data/alias', '/data/real', 1)
    expect(ws.namespace.linkNamesUnder('/data/alias')).toEqual(new Set(['lk']))
    await ws.close()
  })

  it('purgeUnder drops nested entries', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/sub/a', '/t1', 1)
    await ws.namespace.symlink('/data/sub/deep/b', '/t2', 1)
    await ws.namespace.symlink('/data/keep', '/t3', 1)
    expect(await ws.namespace.purgeUnder('/data/sub')).toBe(2)
    expect(ws.namespace.isLink('/data/keep')).toBe(true)
    expect(ws.namespace.isLink('/data/sub/a')).toBe(false)
    await ws.close()
  })
})

describe('Namespace node metadata overlay', () => {
  it('setAttrs creates an overlay node that is not a link', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.setAttrs('/data/f.txt', { mode: 0o601, uid: 500, gid: 'dev' })
    const meta = ws.namespace.metaFor('/data/f.txt')
    expect(meta?.target).toBeUndefined()
    expect(meta?.mode).toBe(0o601)
    expect(meta?.uid).toBe(500)
    expect(meta?.gid).toBe('dev')
    expect(ws.namespace.isLink('/data/f.txt')).toBe(false)
    await ws.close()
  })

  it('partial setAttrs updates keep earlier fields', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.setAttrs('/data/f.txt', { mode: 0o600 })
    await ws.namespace.setAttrs('/data/f.txt', { uid: 'alice' })
    const meta = ws.namespace.metaFor('/data/f.txt')
    expect(meta?.mode).toBe(0o600)
    expect(meta?.uid).toBe('alice')
    await ws.close()
  })

  it('setAttrs on a link keeps its target', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/link', '/t1', 1)
    await ws.namespace.setAttrs('/data/link', { mtime: 2 })
    const meta = ws.namespace.metaFor('/data/link')
    expect(meta?.target).toBe('/t1')
    expect(meta?.mtime).toBe(2)
    expect(ws.namespace.readlink('/data/link')).toBe('/t1')
    await ws.close()
  })

  it('overlay nodes never appear in the symlink views', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.setAttrs('/data/f.txt', { mode: 0o600 })
    expect(ws.namespace.symlinkTargets().size).toBe(0)
    expect(ws.namespace.hasLinks()).toBe(false)
    await ws.close()
  })

  it('unlink and rename move overlay nodes', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.setAttrs('/data/f.txt', { mode: 0o600 })
    await ws.namespace.rename('/data/f.txt', '/data/g.txt')
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()
    expect(ws.namespace.metaFor('/data/g.txt')?.mode).toBe(0o600)
    await ws.namespace.unlink('/data/g.txt')
    expect(ws.namespace.metaFor('/data/g.txt')).toBeNull()
    await ws.close()
  })

  it('clearTimes keeps mode and ownership, drops time-only nodes', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.setAttrs('/data/f.txt', {
      mode: 0o601,
      uid: 500,
      mtime: 1,
      atime: '2026-03-04T12:00:00+00:00',
    })
    await ws.namespace.clearTimes('/data/f.txt')
    const meta = ws.namespace.metaFor('/data/f.txt')
    expect(meta?.mtime).toBeUndefined()
    expect(meta?.atime).toBeUndefined()
    expect(meta?.mode).toBe(0o601)
    expect(meta?.uid).toBe(500)
    await ws.namespace.setAttrs('/data/g.txt', { mtime: 1 })
    await ws.namespace.clearTimes('/data/g.txt')
    expect(ws.namespace.metaFor('/data/g.txt')).toBeNull()
    await ws.close()
  })

  it('clearTimes leaves links alone', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/link', '/t1', 1)
    await ws.namespace.clearTimes('/data/link')
    expect(ws.namespace.metaFor('/data/link')?.mtime).toBe(1)
    await ws.close()
  })

  it('dropAttrs removes applied fields and deletes emptied nodes', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.setAttrs('/data/f.txt', { mode: 0o601, uid: 500 })
    await ws.namespace.dropAttrs('/data/f.txt', ['mode'])
    const meta = ws.namespace.metaFor('/data/f.txt')
    expect(meta?.mode).toBeUndefined()
    expect(meta?.uid).toBe(500)
    await ws.namespace.setAttrs('/data/g.txt', { mode: 0o601 })
    await ws.namespace.dropAttrs('/data/g.txt', ['mode'])
    expect(ws.namespace.metaFor('/data/g.txt')).toBeNull()
    await ws.close()
  })

  it('dropAttrs keeps a link target and is a no-op on a missing node', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.symlink('/data/link', '/t1', 1)
    await ws.namespace.dropAttrs('/data/link', ['target', 'mtime'])
    expect(ws.namespace.readlink('/data/link')).toBe('/t1')
    expect(ws.namespace.metaFor('/data/link')?.mtime).toBeUndefined()
    await ws.namespace.dropAttrs('/data/nope.txt', ['mode'])
    expect(ws.namespace.metaFor('/data/nope.txt')).toBeNull()
    await ws.close()
  })

  it('dropOverlay removes an orphaned overlay but keeps symlinks', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.setAttrs('/data/f.txt', { mode: 0o601, uid: 500 })
    expect(await ws.namespace.dropOverlay('/data/f.txt')).toBe(true)
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()

    await ws.namespace.symlink('/data/link', '/data/target', 1)
    expect(await ws.namespace.dropOverlay('/data/link')).toBe(false)
    expect(ws.namespace.readlink('/data/link')).toBe('/data/target')

    expect(await ws.namespace.dropOverlay('/data/nope.txt')).toBe(false)
    await ws.close()
  })

  it('unlinkGlob matches segment-wise and purges under matched dirs', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.setAttrs('/data/a.log', { mode: 0o600 })
    await ws.namespace.setAttrs('/data/sub/b.log', { mode: 0o600 })
    await ws.namespace.setAttrs('/data/keep.txt', { mode: 0o600 })
    expect(await ws.namespace.unlinkGlob('/data/*.log')).toBe(1)
    expect(ws.namespace.metaFor('/data/a.log')).toBeNull()
    expect(ws.namespace.metaFor('/data/sub/b.log')).not.toBeNull()
    expect(ws.namespace.metaFor('/data/keep.txt')).not.toBeNull()
    await ws.namespace.setAttrs('/data/sub/deep/a.txt', { mode: 0o600 })
    expect(await ws.namespace.unlinkGlob('/data/s*')).toBe(2)
    expect(ws.namespace.metaFor('/data/sub/deep/a.txt')).toBeNull()
    expect(ws.namespace.metaFor('/data/keep.txt')).not.toBeNull()
    await ws.close()
  })
})

describe('Namespace + NamespaceStore', () => {
  it('mutations write through to the store', async () => {
    const store = new RAMNamespaceStore()
    const ws = new Workspace({ '/data': new RAMVFS() }, { namespaceStore: store })
    await ws.namespace.symlink('/data/link', '/t1', 1)
    await ws.namespace.setAttrs('/data/f.txt', { mode: 0o601 })
    let entries = await store.load()
    expect(entries.get('/data/link')).toEqual({ target: '/t1', mtime: 1 })
    expect(entries.get('/data/f.txt')).toEqual({ mode: 0o601 })
    await ws.namespace.unlink('/data/f.txt')
    expect((await store.load()).get('/data/f.txt')).toBeUndefined()
    await ws.namespace.rename('/data/link', '/data/moved')
    entries = await store.load()
    expect(entries.get('/data/link')).toBeUndefined()
    expect(entries.get('/data/moved')).toEqual({ target: '/t1', mtime: 1 })
    await ws.close()
  })

  it('ensureLoaded hydrates the table from the store', async () => {
    const store = new RAMNamespaceStore()
    await store.set('/data/link', { target: '/t1', mtime: 1 })
    await store.set('/data/f.txt', { mode: 0o601, uid: 500 })
    const ws = new Workspace({ '/data': new RAMVFS() }, { namespaceStore: store })
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()
    await ws.namespace.ensureLoaded()
    expect(ws.namespace.readlink('/data/link')).toBe('/t1')
    expect(ws.namespace.metaFor('/data/f.txt')).toEqual({ mode: 0o601, uid: 500 })
    await ws.close()
  })

  it('replaceNodes wins over prior store content', async () => {
    const store = new RAMNamespaceStore()
    await store.set('/data/stale', { mode: 0o600 })
    const ws = new Workspace({ '/data': new RAMVFS() }, { namespaceStore: store })
    await ws.namespace.replaceNodes(new Map([['/data/fresh', { mode: 0o601 }]]))
    await ws.namespace.ensureLoaded()
    expect(ws.namespace.metaFor('/data/stale')).toBeNull()
    expect(ws.namespace.metaFor('/data/fresh')).toEqual({ mode: 0o601 })
    expect((await store.load()).get('/data/stale')).toBeUndefined()
    await ws.close()
  })

  it('user is null before resolution', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    expect(ws.namespace.user).toBeNull()
    await ws.close()
  })

  it('explicit agentId claims the user and writes through', async () => {
    const store = new RAMNamespaceStore()
    await store.setUser('bob')
    const ws = new Workspace({ '/data': new RAMVFS() }, { agentId: 'alice', namespaceStore: store })
    expect(ws.namespace.user).toBe('alice')
    await ws.namespace.ensureLoaded()
    expect(ws.namespace.user).toBe('alice')
    expect(await store.loadUser()).toBe('alice')
    await ws.close()
  })

  it('bare launch adopts the stored user', async () => {
    const store = new RAMNamespaceStore()
    await store.setUser('alice')
    const ws = new Workspace({ '/data': new RAMVFS() }, { namespaceStore: store })
    await ws.namespace.ensureLoaded()
    expect(ws.namespace.user).toBe('alice')
    await ws.close()
  })

  it('bare launch with an empty store has no user', async () => {
    const store = new RAMNamespaceStore()
    const ws = new Workspace({ '/data': new RAMVFS() }, { namespaceStore: store })
    await ws.namespace.ensureLoaded()
    expect(ws.namespace.user).toBeNull()
    expect(await store.loadUser()).toBeNull()
    await ws.close()
  })

  it('replaceNodes still resolves the user', async () => {
    const store = new RAMNamespaceStore()
    await store.setUser('bob')
    const ws = new Workspace({ '/data': new RAMVFS() }, { agentId: 'alice', namespaceStore: store })
    await ws.namespace.replaceNodes(new Map([['/data/fresh', { mode: 0o601 }]]))
    expect(ws.namespace.user).toBe('alice')
    expect(await store.loadUser()).toBe('alice')
    await ws.close()
  })
})

describe('Namespace extended attributes', () => {
  const ENC = new TextEncoder()

  it('live on the node and leave with the last one', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    await ws.namespace.setXattr('/data/f.txt', 'user.a', ENC.encode('one'))
    await ws.namespace.setAttrs('/data/g.txt', { mode: 0o600 })
    await ws.namespace.setXattr('/data/g.txt', 'user.b', ENC.encode('two'))
    expect([...ws.namespace.xattrs('/data/f.txt').keys()]).toEqual(['user.a'])
    await ws.namespace.removeXattr('/data/f.txt', 'user.a')
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()
    await ws.namespace.removeXattr('/data/g.txt', 'user.b')
    expect(ws.namespace.metaFor('/data/g.txt')).toEqual({ mode: 0o600 })
    await ws.close()
  })

  it('ride the flat fields as base64', () => {
    const meta = { mode: 0o644, xattrs: new Map([['user.bin', new Uint8Array([0, 255])]]) }
    const fields = metaToFields(meta)
    expect(fields['xattr:user.bin']).toBe('AP8=')
    expect(metaFromFields(fields)).toEqual(meta)
  })

  it('survive a store round trip', async () => {
    const store = new RAMNamespaceStore()
    const first = new Workspace({ '/data': new RAMVFS() }, { namespaceStore: store })
    await first.namespace.setXattr('/data/f.txt', 'user.a', ENC.encode('one'))
    const second = new Workspace({ '/data': new RAMVFS() }, { namespaceStore: store })
    await second.namespace.ensureLoaded()
    expect(new TextDecoder().decode(second.namespace.xattrs('/data/f.txt').get('user.a'))).toBe(
      'one',
    )
    await first.close()
    await second.close()
  })
})
