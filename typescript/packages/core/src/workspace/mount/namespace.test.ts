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
import { RAMResource } from '../../resource/ram/ram.ts'
import { CycleError } from '../../utils/path.ts'
import { Workspace } from '../workspace.ts'

describe('Namespace facade (addressing)', () => {
  it('resolve delegates to the workspace resolver', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    const viaNs = await ws.namespace.resolve('/data/a.txt')
    const viaWs = await ws.resolve('/data/a.txt')
    expect(viaNs).toEqual(viaWs)
    await ws.close()
  })

  it('follow is a no-op without a symlink table', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    const withFollow = await ws.namespace.resolve('/data/a.txt', true)
    const noFollow = await ws.namespace.resolve('/data/a.txt', false)
    expect(withFollow).toEqual(noFollow)
    await ws.close()
  })

  it('mountFor returns the owning mount', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    const mount = ws.namespace.mountFor('/data/a.txt')
    expect(mount?.prefix).toBe('/data/')
    await ws.close()
  })
})

describe('Namespace symlink table', () => {
  it('symlink/readlink round-trip verbatim', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    ws.namespace.symlink('/data/link', '/data/hello.txt', 1)
    expect(ws.namespace.isLink('/data/link')).toBe(true)
    expect(ws.namespace.readlink('/data/link')).toBe('/data/hello.txt')
    await ws.close()
  })

  it('readlink of a missing link returns null', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    expect(ws.namespace.readlink('/data/nope')).toBeNull()
    await ws.close()
  })

  it('stores a relative target verbatim', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    ws.namespace.symlink('/data/link', 'hello.txt', 1)
    expect(ws.namespace.readlink('/data/link')).toBe('hello.txt')
    await ws.close()
  })

  it('unlink removes the link', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    ws.namespace.symlink('/data/link', '/data/hello.txt', 1)
    expect(ws.namespace.unlink('/data/link')).toBe(true)
    expect(ws.namespace.isLink('/data/link')).toBe(false)
    expect(ws.namespace.unlink('/data/link')).toBe(false)
    await ws.close()
  })

  it('rename moves the link entry', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    ws.namespace.symlink('/data/a', '/data/hello.txt', 1)
    expect(ws.namespace.rename('/data/a', '/data/b')).toBe(true)
    expect(ws.namespace.isLink('/data/a')).toBe(false)
    expect(ws.namespace.readlink('/data/b')).toBe('/data/hello.txt')
    await ws.close()
  })

  it('resolve follows a link to its target mount', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    ws.namespace.symlink('/data/link', '/data/hello.txt', 1)
    const viaLink = await ws.namespace.resolve('/data/link', true)
    const viaTarget = await ws.namespace.resolve('/data/hello.txt')
    expect(viaLink).toEqual(viaTarget)
    await ws.close()
  })

  it('resolve without follow keeps the link path', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    ws.namespace.symlink('/data/link', '/data/hello.txt', 1)
    const noFollow = await ws.namespace.resolve('/data/link', false)
    const [, spec] = noFollow
    expect(spec.virtual).toBe('/data/link')
    await ws.close()
  })

  it('resolve throws CycleError on a symlink loop', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    ws.namespace.symlink('/data/a', '/data/b', 1)
    ws.namespace.symlink('/data/b', '/data/a', 1)
    await expect(ws.namespace.resolve('/data/a', true)).rejects.toThrow(CycleError)
    await ws.close()
  })
})
