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
// Mirrors python/tests/commands/builtin/utils/test_links.py.

import { describe, expect, it } from 'vitest'
import { IOResult } from '../../../io/types.ts'
import type { LinkView, NamespaceLinks } from '../../../view/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import {
  DEFAULT_VISIBILITY,
  FileStat,
  FileType,
  MountMode,
  PathSpec,
  type Visibility,
  type WalkErrno,
} from '../../../types.ts'
import { Files } from '../../../workspace/files.ts'
import { readers } from '../../../test-utils.ts'
import { isDotWalkError } from '../../../errors/fs.ts'
import { CycleError } from '../../../utils/path.ts'
import type { Context } from '../../config.ts'
import { runWithMountGate } from '../../../context/session_context.ts'
import {
  LinkResolver,
  crossesMounts,
  linkResolver,
  linkView,
  mountRoot,
  mountView,
  mountsOf,
  nameLocation,
  owedNames,
  typedLink,
} from './links.ts'

function spec(virtual: string, rawPath: string, walkError: WalkErrno | null = null): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/') + 1) || '/',
    vfsPath: virtual.replace(/^\/+/, ''),
    rawPath,
    walkError,
  })
}

// A LinkView over a table of link paths and what each one names, which
// `resolve` follows from any path under the link too.
function links(table: Record<string, string>): LinkView {
  return {
    statAt: (path) =>
      path in table
        ? new FileStat({ name: path.split('/').pop() ?? '', type: FileType.SYMLINK })
        : null,
    subtree: () => [],
    resolve: (path) => {
      if (table[path] === path) throw new CycleError(path)
      for (const [link, target] of Object.entries(table)) {
        if (path === link || path.startsWith(link + '/')) return target + path.slice(link.length)
      }
      return path
    },
    exists: () => Promise.resolve(false),
    targetStat: () => Promise.resolve(null),
  }
}

const LINKS = links({ '/data/dl': '/data/dir', '/data/dir/tl.gz': '/data/t.gz' })

describe('the name an operand was typed as', () => {
  it('stands in the directory its parent link names', () => {
    // The router left `virtual` at the target; the name is still the link.
    const typed = spec('/data/t.gz', 'dl/tl.gz')
    expect(nameLocation(LINKS, typed, '/data')).toBe('/data/dir/tl.gz')
    expect(typedLink(LINKS, typed, '/data')).not.toBeNull()
  })

  it.each(['dl/tl.gz/', 'dl/.', 'dl/..'])(
    '%s stands nowhere: its last component resolves',
    (raw) => {
      expect(nameLocation(LINKS, spec('/data/dir', raw), '/data')).toBeNull()
    },
  )

  it('stands nowhere once its walk failed', () => {
    expect(nameLocation(LINKS, spec('/data/l1', 'l1', 'ELOOP'), '/data')).toBeNull()
  })

  it('is no link when nothing stands there', () => {
    expect(typedLink(LINKS, spec('/data/a.txt', 'a.txt'), '/data')).toBeNull()
  })
})

function recorder(): [DispatchFn, [string, string, readonly unknown[], Record<string, unknown>][]] {
  const calls: [string, string, readonly unknown[], Record<string, unknown>][] = []
  const dispatch: DispatchFn = (op, path, args = [], kwargs = {}) => {
    calls.push([op, path.virtual, args, kwargs])
    if (op === 'read')
      return Promise.resolve([new TextEncoder().encode('through the dispatcher'), new IOResult()])
    if (op === 'readdir')
      return Promise.resolve([[`${path.virtual}/a`, `${path.virtual}/b`], new IOResult()])
    return Promise.resolve([new FileStat({ name: 'n', type: FileType.SYMLINK }), new IOResult()])
  }
  return [dispatch, calls]
}

describe('the link resolver', () => {
  it('reads, writes and unlinks by the name it is handed', async () => {
    const [dispatch, calls] = recorder()
    const resolver = new LinkResolver(LINKS, dispatch, '/data')
    const read: Uint8Array[] = []
    for await (const chunk of resolver.read('/data/dir/tl.gz')) read.push(chunk)
    expect(new TextDecoder().decode(read[0])).toBe('through the dispatcher')
    const data = new TextEncoder().encode('x')
    await resolver.write('/data/dir/tl', data)
    await resolver.unlink('/data/dir/tl.gz')
    await resolver.lstat(PathSpec.fromStrPath('/data/dir/tl.gz'))
    expect(calls).toEqual([
      ['read', '/data/dir/tl.gz', [], { stream: true }],
      ['write', '/data/dir/tl', [data], {}],
      ['unlink', '/data/dir/tl.gz', [], {}],
      ['stat', '/data/dir/tl.gz', [], { nofollow: true }],
    ])
  })

  it('sees a link the router followed vanish before its turn', () => {
    const [dispatch] = recorder()
    const resolver = new LinkResolver(links({}), dispatch, '/data')
    const followed = spec('/data/t.gz', 'tl.gz')
    expect(resolver.vanished(followed)).toBe(true)
    expect(resolver.linkAt(followed)).toBeNull()
    expect(resolver.vanished(spec('/data/t.gz', 't.gz'))).toBe(false)
  })

  it('lists and stats by the name it is handed', async () => {
    const [dispatch, calls] = recorder()
    const resolver = new LinkResolver(LINKS, dispatch, '/data')
    expect(await resolver.readdir('/data/dir')).toEqual(['/data/dir/a', '/data/dir/b'])
    expect((await resolver.stat('/data/t.gz')).name).toBe('n')
    expect(calls).toEqual([
      ['readdir', '/data/dir', [], {}],
      ['stat', '/data/t.gz', [], {}],
    ])
  })

  it('leads where the table resolves a link, and a loop is ELOOP', () => {
    const [dispatch] = recorder()
    expect(new LinkResolver(LINKS, dispatch, '/data').target('/data/dir/tl.gz')).toBe('/data/t.gz')
    const looped = new LinkResolver(links({ '/data/l': '/data/l' }), dispatch, '/data')
    let caught: unknown = null
    try {
      looped.target('/data/l')
    } catch (err) {
      caught = err
    }
    expect(isDotWalkError(caught) && caught.code).toBe('ELOOP')
  })

  it('is absent without files or links', () => {
    const [dispatch] = recorder()
    const base: Context = { stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/') }
    expect(linkResolver(base)).toBeNull()
    expect(linkResolver({ ...base, vfs: new Files(dispatch) })).toBeNull()
    expect(linkResolver({ ...base, vfs: new Files(dispatch, readers([], table({}))) })?.cwd).toBe(
      '/',
    )
  })
})

// A namespace link table over link paths and their targets.
function table(targets: Record<string, string>): NamespaceLinks {
  const row = (path: string): FileStat | null =>
    path in targets
      ? new FileStat({ name: path.split('/').pop() ?? '', type: FileType.SYMLINK })
      : null
  return {
    follow: (path: string) => targets[path] ?? path,
    linkStatAt: row,
    linkStatsBelow: (directory: string) =>
      Object.keys(targets)
        .filter((path) => path.startsWith(directory.replace(/\/+$/, '') + '/'))
        .sort()
        .map((path): [string, FileStat] => [
          path,
          new FileStat({ name: path.split('/').pop() ?? '', type: FileType.SYMLINK }),
        ]),
    symlinkTargets: () => new Map(Object.entries(targets)),
  } as unknown as NamespaceLinks
}

function files(prefixes: string[], links: NamespaceLinks | null = null, vis?: Visibility) {
  const [dispatch] = recorder()
  return new Files(dispatch, readers(prefixes, links, vis ?? null))
}

describe('owedNames', () => {
  it('derives from the mount table', () => {
    const vfs = files(['/base/', '/base/inner/', '/dev/'])
    expect(owedNames(vfs, '/base')).toEqual(['inner'])
    expect(owedNames(vfs, '/')).toEqual(['base', 'dev'])
    expect(owedNames(vfs, '/dev')).toEqual([])
  })

  // A link below a directory chain no backend serves synthesizes its
  // ancestors, exactly as a nested mount prefix does, so `ls /` shows the
  // way to it.
  it('includes link ancestors', () => {
    const vfs = files(['/base/'], table({ '/ghost/deep/lnk': '/base' }))
    expect(owedNames(vfs, '/')).toEqual(['base', 'ghost'])
    expect(owedNames(vfs, '/ghost')).toEqual(['deep'])
    expect(owedNames(undefined, '/')).toEqual([])
  })
})

describe('linkView', () => {
  it('is live whenever the files hold a table', () => {
    const targets: Record<string, string> = {}
    const view = linkView(files([], table(targets)))
    expect(view?.subtree('/')).toEqual([])
    targets['/data/l'] = '/data/a'
    expect(view?.statAt('/data/l')).not.toBeNull()
    expect(linkView(files([]))).toBeUndefined()
    expect(linkView(undefined)).toBeUndefined()
  })
})

describe('a link the session cannot see', () => {
  // A hidden link, and a visible one that leads where the session cannot
  // see, have no row, no subtree entry, no owed name and no target;
  // resolving a hidden path leaves it as typed.
  it('is never answered', async () => {
    const hidden: Visibility = {
      ...DEFAULT_VISIBILITY,
      paths: { paths: ['/data/secret'], patterns: [] },
    }
    const vfs = files(
      ['/data/'],
      table({
        '/data/open': '/data/a',
        '/data/door': '/data/secret',
        '/data/secret/l': '/data/a',
        '/ghost/deep/lnk': '/data/secret',
      }),
      hidden,
    )
    const view = linkView(vfs)
    expect(view?.statAt('/data/open')).not.toBeNull()
    expect(view?.statAt('/data/door')).toBeNull()
    expect(view?.statAt('/data/secret/l')).toBeNull()
    expect(view?.subtree('/data').map(([path]) => path)).toEqual(['/data/open'])
    expect(view?.resolve('/data/secret/l')).toBe('/data/secret/l')
    expect(await view?.targetStat('/data/door')).toBeNull()
    expect(owedNames(vfs, '/data')).toEqual(['open'])
    expect(owedNames(vfs, '/')).toEqual(['data'])
  })
})

describe('mountView', () => {
  it('stops at a hidden mount but never names it', () => {
    const hidden: Visibility = {
      ...DEFAULT_VISIBILITY,
      paths: { paths: ['/data/secret'], patterns: [] },
    }
    const vfs = files(['/data/', '/data/open/', '/data/secret/'], null, hidden)
    const mounts = mountView(vfs)
    expect(mounts?.descendants('/data')).toEqual(['/data/open', '/data/secret'])
    expect(mounts?.visibleDescendants('/data')).toEqual(['/data/open'])
    expect(mounts?.rootOf('/data/open/x')).toBe('/data/open/')
    expect(mounts?.isRoot('/data/secret')).toBe(true)
    const crossing = mountView(vfs, true)
    expect(crossing?.descendants('/data')).toEqual([])
    expect(crossing?.isRoot('/data/open')).toBe(false)
    expect(crossing?.rootOf('/data/open/x')).toBe('/data/open/')
  })
})

describe('mountsOf', () => {
  const ctxOf = (vfs: Files): Context => ({
    stdin: null,
    flags: {},
    cwd: PathSpec.fromStrPath('/'),
    vfs,
  })

  it('walks and answers as its mount inside a mount scope, and across outside one', async () => {
    const row = {
      prefix: '/data/',
      kind: 'ram',
      mode: MountMode.WRITE,
      calls: new Set(['read_tree']),
    }
    const [dispatch] = recorder()
    const ctx = ctxOf(new Files(dispatch, readers([row, '/data/inner/'])))
    const across = mountsOf(ctx)
    expect([crossesMounts(ctx), mountRoot(ctx)]).toEqual([true, ''])
    expect(across?.descendants('/data')).toEqual([])
    expect(across?.answers('/data/x', 'read_tree')).toBe(false)
    await runWithMountGate('/data/', MountMode.WRITE, () => {
      const bound = mountsOf(ctx)
      expect([crossesMounts(ctx), mountRoot(ctx)]).toEqual([false, '/data'])
      expect(bound?.descendants('/data')).toEqual(['/data/inner'])
      expect(bound?.answers('/data/x', 'read_tree')).toBe(true)
      expect(bound?.answers('/data/x', 'first_lines')).toBe(false)
      return Promise.resolve()
    })
  })

  // The bound mount may be another task's (no task isolation): the files' own wins.
  it('reads the mount its files were said to run in over the bound one', async () => {
    const vfs = files(['/data/', '/other/'])
    const on = ctxOf(vfs.servedBy(['/data/', MountMode.WRITE]))
    const across = ctxOf(vfs.servedBy(null))
    await runWithMountGate('/other/', MountMode.WRITE, () => {
      expect([crossesMounts(on), mountRoot(on)]).toEqual([false, '/data'])
      expect([crossesMounts(across), mountRoot(across)]).toEqual([true, ''])
      return Promise.resolve()
    })
  })
})
