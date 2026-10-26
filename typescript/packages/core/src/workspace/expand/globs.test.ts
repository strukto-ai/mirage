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
import type { NamespaceLinks } from '../../view/types.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { IOResult } from '../../io/types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { MountRegistry } from '../mount/registry.ts'
import { Workspace } from '../workspace/workspace.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { resolveGlobs } from './globs.ts'

class PlainVFS extends BaseVFS {
  override readonly name = 'plain'
  override close(): Promise<void> {
    return Promise.resolve()
  }
}

// A VFS whose stat answers only once its mount was readied, the way a
// mount nothing has touched yet behaves.
class LazyDirVFS extends BaseVFS {
  override readonly name = 'lazy'
  ready = false
  override close(): Promise<void> {
    return Promise.resolve()
  }
  override stat(path: PathSpec): Promise<FileStat> {
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
    followParent: (p) => p,
    isLink: (p) => p === '/ram/lnk',
    readlink: (p) => (p === '/ram/lnk' ? target : null),
    linkStatAt: () => null,
    symlinkTargets: () => new Map([['/ram/lnk', target]]),
    linkStatsBelow: () => [],
    linkNamesUnder: (d) => new Set(d === '/ram' ? ['lnk'] : []),
  }
}

// A VFS that lists, whose listing the registry's dispatcher answers.
class ListedVFS extends BaseVFS {
  override readonly name = 'listed'
  override close(): Promise<void> {
    return Promise.resolve()
  }
  override readdir(): Promise<FileStat[]> {
    return Promise.resolve([])
  }
}

// The mounts with a dispatcher that lists `listing` for every directory and
// stats on the mount serving the path.
function globRegistry(
  mounts: Record<string, BaseVFS>,
  mode: MountMode,
  listing: readonly string[] = [],
): MountRegistry {
  const reg = new MountRegistry(mounts, mode)
  reg.setDispatch(async (name, path) => {
    if (name === 'readdir') return [[...listing], new IOResult()]
    return [await reg.mountFor(path.virtual).call(name, path.virtual), new IOResult()]
  })
  return reg
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

  it('passes through glob PathSpecs when the VFS lists nothing', async () => {
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
    const reg = globRegistry({ '/ram': new ListedVFS(), '/other': other }, MountMode.WRITE)
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

  it('expands glob PathSpecs through the dispatcher listing', async () => {
    const reg = globRegistry({ '/ram': new ListedVFS() }, MountMode.WRITE, [
      '/ram/a.txt',
      '/ram/b.txt',
    ])
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
    const reg = globRegistry({ '/ram': new ListedVFS() }, MountMode.WRITE, [
      '/ram/*a.txt',
      '/ram/xa.txt',
    ])
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

  it('keeps the literal word on zero matches (bash nullglob off)', async () => {
    const reg = globRegistry({ '/ram': new ListedVFS() }, MountMode.WRITE)
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
    const reg = globRegistry({ '/ram': new ListedVFS() }, MountMode.WRITE, ['/ram/sub/a.txt'])
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
    const reg = globRegistry({ '/ram': new ListedVFS() }, MountMode.WRITE, ['/ram/a.txt'])
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
    const reg = globRegistry({ '/ram': new ListedVFS() }, MountMode.WRITE)
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

// A glob's listing never sees the mount prefix: the backend is handed each
// directory keyed `mountKey(virtual, prefix)`, on every entry point that
// expands a word (the workspace expander, its mid-path and globstar walks,
// and the builtins' operands), a quoted prefix read by its literal spelling.
// Pinned the same way in python's test_globs.py.
describe('a glob listing under a non-root mount prefix', () => {
  it('is handed keys below the prefix on every expansion path', async () => {
    const vfs = new RAMVFS()
    const ws = new Workspace({ '/mnt/x+/': vfs }, { mode: MountMode.WRITE })
    const derived = vfs.readdir.bind(vfs)
    const seen: [string, string][] = []
    vfs.readdir = (path) => {
      seen.push([path.virtual, path.vfsPath])
      return derived(path)
    }
    for (const line of [
      'mkdir -p /mnt/x+/team/sub',
      'printf 1 > /mnt/x+/team/f1',
      'printf 2 > /mnt/x+/tea.txt',
      'printf 3 > /mnt/x+/other',
    ]) {
      await ws.shell(line)
    }
    const cases: [string, string][] = [
      ['echo /mnt/x+/*', '/mnt/x+/other /mnt/x+/tea.txt /mnt/x+/team'],
      ['echo /mnt/x+/*/f*', '/mnt/x+/team/f1'],
      ['cd /mnt/x+ && echo tea*', 'tea.txt team'],
      ['shopt -s globstar; echo /mnt/x+/**/f1', '/mnt/x+/team/f1'],
      ['touch /mnt/x+/tea* && echo touched', 'touched'],
      ["echo '/mnt/x+'/t*", '/mnt/x+/tea.txt /mnt/x+/team'],
    ]
    for (const [line, want] of cases) {
      expect((await ws.shell(line)).stdoutText.trim(), line).toBe(want)
    }
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.filter(([v, key]) => key !== mountKey(v, '/mnt/x+'))).toEqual([])
    await ws.close()
  })
})

// The listing a glob walks is the dispatcher's, so a hidden file, a hidden
// nested mount and a link leading where the session cannot see match
// nothing, at any depth. Pinned the same way in python's test_globs.py.
describe('a glob under a session that hides paths', () => {
  it.each([
    ['echo /base/*', '/base/f1 /base/sub\n'],
    ['shopt -s dotglob; echo /base/*', '/base/f1 /base/sub\n'],
    ['echo /base/*/*', '/base/*/*\n'],
    ['echo /base/*/', '/base/sub/\n'],
    ['shopt -s globstar; echo /base/**', '/base/ /base/f1 /base/sub\n'],
    ['for f in /base/*; do echo $f; done', '/base/f1\n/base/sub\n'],
    ['touch /base/*.key; echo /base/*', '/base/f1 /base/sub\n'],
  ])('never matches what it hides: %s', async (line, expected) => {
    const ws = new Workspace(
      { '/': new RAMVFS(), '/base/inner': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    try {
      for (const seed of [
        'mkdir -p /base/sub',
        'printf 111 > /base/f1',
        'printf 2222222 > /base/sub/f2',
        'printf 3333333 > /base/inner/g1',
        'ln -s /base/sub/f2 /base/link',
        'printf k > /base/sub/f.key',
        'printf k > /base/top.key',
        'ln -s /base/sub/f.key /base/.alias',
      ]) {
        await ws.shell(seed)
      }
      ws.createSession('n', {
        profile: parseSessionProfile({
          paths: { hide: ['*.key', '/base/inner', '/base/sub/f2'] },
        }),
      })
      expect((await ws.shell(line, { sessionId: 'n' })).stdoutText).toBe(expected)
    } finally {
      await ws.close()
    }
  })
})
