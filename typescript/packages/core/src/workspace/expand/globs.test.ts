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
import type { NamespaceLinks } from '../../ops/config.ts'
import { BaseVFS, type VFS } from '../../vfs/base.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { MountRegistry } from '../mount/registry.ts'
import { resolveGlobs, type ResourceWithGlob } from './globs.ts'

class PlainVFS extends BaseVFS implements VFS {
  readonly kind = 'plain'
  open(): Promise<void> {
    return Promise.resolve()
  }
  override close(): Promise<void> {
    return Promise.resolve()
  }
}

// A VFS that implements nullglob-off on its own: a no-match ask comes
// back as the spec it was handed. `glob` is a public hook, so the shape
// resolveGlobs sends is not a contract it can rely on.
class EchoGlobVFS extends BaseVFS implements ResourceWithGlob {
  readonly kind = 'echo'
  open(): Promise<void> {
    return Promise.resolve()
  }
  override close(): Promise<void> {
    return Promise.resolve()
  }
  glob(paths: readonly PathSpec[]): Promise<PathSpec[]> {
    return Promise.resolve([...paths])
  }
}

// A VFS whose stat answers only once its mount was readied, the way a
// mount nothing has touched yet behaves.
class LazyDirVFS extends BaseVFS implements VFS {
  readonly kind = 'lazy'
  ready = false
  open(): Promise<void> {
    return Promise.resolve()
  }
  override close(): Promise<void> {
    return Promise.resolve()
  }
  stat(path: PathSpec): Promise<FileStat> {
    if (!this.ready) return Promise.reject(enoent(path))
    return Promise.resolve(
      new FileStat({ name: path.virtual.split('/').pop() ?? '', type: FileType.DIRECTORY }),
    )
  }
}

// One link, from the globbed directory into a second mount.
function linkTo(target: string): NamespaceLinks {
  return {
    follow: (p) => (p === '/ram/lnk' ? target : p),
    isLink: (p) => p === '/ram/lnk',
    readlink: (p) => (p === '/ram/lnk' ? target : null),
    linkStatAt: () => null,
    symlinkTargets: () => new Map([['/ram/lnk', target]]),
  }
}

class GlobVFS extends BaseVFS implements ResourceWithGlob {
  readonly kind = 'glob'
  constructor(private readonly results: PathSpec[]) {
    super()
  }
  open(): Promise<void> {
    return Promise.resolve()
  }
  override close(): Promise<void> {
    return Promise.resolve()
  }
  glob(): Promise<PathSpec[]> {
    return Promise.resolve(this.results)
  }
}

describe('resolveGlobs', () => {
  it('passes through plain strings', async () => {
    const reg = new MountRegistry({ '/ram': new PlainVFS() }, MountMode.WRITE)
    const out = await resolveGlobs(['-l', 'text'], reg)
    expect(out).toEqual(['-l', 'text'])
  })

  it('passes through non-glob PathSpecs', async () => {
    const reg = new MountRegistry({ '/ram': new PlainVFS() }, MountMode.WRITE)
    const p = PathSpec.fromStrPath('/ram/x.txt')
    const out = await resolveGlobs([p], reg)
    expect(out).toEqual([p])
  })

  it('passes through glob PathSpecs when the VFS lacks glob', async () => {
    const reg = new MountRegistry({ '/ram': new PlainVFS() }, MountMode.WRITE)
    const p = new PathSpec({
      vfsPath: 'ram/*.txt',
      virtual: '/ram/*.txt',
      directory: '/ram/',
      pattern: '*.txt',
      resolved: false,
    })
    const out = await resolveGlobs([p], reg)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(p)
  })

  // A trailing slash keeps a link to a directory, and the directory can live
  // in a mount nothing has touched yet: the owner is readied before it is
  // asked, as it is before a listing.
  it('readies the mount a trailing-slash match links into before statting it', async () => {
    const other = new LazyDirVFS()
    const reg = new MountRegistry({ '/ram': new GlobVFS([]), '/other': other }, MountMode.WRITE)
    reg.mountFor('/other/dir').beforeUse = () => {
      other.ready = true
      return Promise.resolve()
    }
    const p = new PathSpec({
      vfsPath: 'ram/*',
      virtual: '/ram/*',
      directory: '/ram/',
      pattern: '*',
      resolved: false,
      rawPath: '*/',
    })
    const out = await resolveGlobs([p], reg, false, linkTo('/other/dir'))
    expect(out.map((x) => (x as PathSpec).rawPath)).toEqual(['lnk/'])
  })

  it('expands glob PathSpecs through VFS.glob', async () => {
    const res = new GlobVFS([
      PathSpec.fromStrPath('/ram/a.txt'),
      PathSpec.fromStrPath('/ram/b.txt'),
    ])
    const reg = new MountRegistry({ '/ram': res }, MountMode.WRITE)
    const p = new PathSpec({
      vfsPath: 'ram/*.txt',
      virtual: '/ram/*.txt',
      directory: '/ram/',
      pattern: '*.txt',
      resolved: false,
    })
    const out = await resolveGlobs([p], reg)
    expect(out.map((x) => (x instanceof PathSpec ? x.virtual : x))).toEqual([
      '/ram/a.txt',
      '/ram/b.txt',
    ])
  })

  // A file may be named exactly like the word that globbed for it. The
  // merge layer used to read "the backend handed me back the word I gave
  // it" as "nothing matched", which is what a zero-match backend answers
  // with nullglob off. The two are byte-identical, so the real match was
  // thrown away.
  it('keeps a match named exactly like the glob word', async () => {
    const res = new GlobVFS([
      PathSpec.fromStrPath('/ram/*a.txt'),
      PathSpec.fromStrPath('/ram/xa.txt'),
    ])
    const reg = new MountRegistry({ '/ram': res }, MountMode.WRITE)
    const p = new PathSpec({
      vfsPath: 'ram/*a.txt',
      virtual: '/ram/*a.txt',
      directory: '/ram/',
      pattern: '*a.txt',
      resolved: false,
    })
    const out = await resolveGlobs([p], reg)
    expect(out.map((x) => (x as PathSpec).virtual)).toEqual(['/ram/*a.txt', '/ram/xa.txt'])
    expect(out.every((x) => (x as PathSpec).pattern === null)).toBe(true)
  })

  // The echoed spec is the directory, which is not a child of itself, so
  // it is no match and the word stays literal rather than expanding to
  // `/ram/`.
  it('takes no match from a VFS that reinstates the literal itself', async () => {
    const reg = new MountRegistry({ '/ram': new EchoGlobVFS() }, MountMode.WRITE)
    const p = new PathSpec({
      vfsPath: 'ram/*.nope',
      virtual: '/ram/*.nope',
      directory: '/ram/',
      pattern: '*.nope',
      resolved: false,
    })
    const out = await resolveGlobs([p], reg)
    expect(out).toHaveLength(1)
    expect((out[0] as PathSpec).virtual).toBe('/ram/*.nope')
    expect((out[0] as PathSpec).pattern).toBe('*.nope')
  })

  it('keeps the literal word on zero matches (bash nullglob off)', async () => {
    const res = new GlobVFS([])
    const reg = new MountRegistry({ '/ram': res }, MountMode.WRITE)
    const p = new PathSpec({
      vfsPath: 'ram/*.nope',
      virtual: '/ram/*.nope',
      directory: '/ram/',
      pattern: '*.nope',
      resolved: false,
    })
    const out = await resolveGlobs([p], reg)
    expect(out).toHaveLength(1)
    const kept = out[0]
    expect(kept).toBeInstanceOf(PathSpec)
    expect((kept as PathSpec).virtual).toBe('/ram/*.nope')
    expect((kept as PathSpec).pattern).toBe('*.nope')
  })
})

describe('matchRaw via resolveGlobs', () => {
  it('relative glob matches spelled as typed', async () => {
    const match = new PathSpec({
      vfsPath: 'ram/sub/a.txt',
      virtual: '/ram/sub/a.txt',
      directory: '/ram/sub/',
      resolved: true,
    })
    const res = new GlobVFS([match])
    const reg = new MountRegistry({ '/ram': res }, MountMode.WRITE)
    const p = new PathSpec({
      vfsPath: 'ram/sub/*.txt',
      virtual: '/ram/sub/*.txt',
      directory: '/ram/sub/',
      pattern: '*.txt',
      resolved: false,
      rawPath: 'sub/*.txt',
    })
    const out = await resolveGlobs([p], reg)
    expect((out[0] as PathSpec).rawPath).toBe('sub/a.txt')
    expect((out[0] as PathSpec).virtual).toBe('/ram/sub/a.txt')
  })

  it('absolute glob matches keep the virtual path', async () => {
    const match = new PathSpec({
      vfsPath: 'ram/a.txt',
      virtual: '/ram/a.txt',
      directory: '/ram/',
      resolved: true,
    })
    const res = new GlobVFS([match])
    const reg = new MountRegistry({ '/ram': res }, MountMode.WRITE)
    const p = new PathSpec({
      vfsPath: 'ram/*.txt',
      virtual: '/ram/*.txt',
      directory: '/ram/',
      pattern: '*.txt',
      resolved: false,
    })
    const out = await resolveGlobs([p], reg)
    expect((out[0] as PathSpec).rawPath).toBe((out[0] as PathSpec).virtual)
    expect((out[0] as PathSpec).rawPath).toBe('/ram/a.txt')
  })

  it('zero-match relative glob keeps the typed literal', async () => {
    const res = new GlobVFS([])
    const reg = new MountRegistry({ '/ram': res }, MountMode.WRITE)
    const p = new PathSpec({
      vfsPath: 'ram/*.nope',
      virtual: '/ram/*.nope',
      directory: '/ram/',
      pattern: '*.nope',
      resolved: false,
      rawPath: '*.nope',
    })
    const out = await resolveGlobs([p], reg)
    expect((out[0] as PathSpec).rawPath).toBe('*.nope')
  })
})
