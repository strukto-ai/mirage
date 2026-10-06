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
import type { LinkView } from '../../../ops/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { FileStat, FileType, PathSpec, type WalkErrno } from '../../../types.ts'
import { isDotWalkError } from '../../../errors/fs.ts'
import { CycleError } from '../../../utils/path.ts'
import type { CommandOpts } from '../../config.ts'
import { LinkDoor, linkDoor, nameLocation, typedLink } from './links.ts'

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
    children: (directory) =>
      Object.keys(table)
        .filter((link) => link.slice(0, link.lastIndexOf('/')) === directory.replace(/\/+$/, ''))
        .map((link) => new FileStat({ name: link.split('/').pop() ?? '', type: FileType.SYMLINK })),
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
      return Promise.resolve([new TextEncoder().encode('through the door'), new IOResult()])
    if (op === 'readdir')
      return Promise.resolve([[`${path.virtual}/a`, `${path.virtual}/b`], new IOResult()])
    return Promise.resolve([new FileStat({ name: 'n', type: FileType.SYMLINK }), new IOResult()])
  }
  return [dispatch, calls]
}

describe('the link door', () => {
  it('reads, writes and unlinks by the name it is handed', async () => {
    const [dispatch, calls] = recorder()
    const door = new LinkDoor(LINKS, dispatch, '/data')
    const read: Uint8Array[] = []
    for await (const chunk of door.read('/data/dir/tl.gz')) read.push(chunk)
    expect(new TextDecoder().decode(read[0])).toBe('through the door')
    const data = new TextEncoder().encode('x')
    await door.write('/data/dir/tl', data)
    await door.unlink('/data/dir/tl.gz')
    await door.lstat(PathSpec.fromStrPath('/data/dir/tl.gz'))
    expect(calls).toEqual([
      ['read', '/data/dir/tl.gz', [], {}],
      ['write', '/data/dir/tl', [data], {}],
      ['unlink', '/data/dir/tl.gz', [], {}],
      ['stat', '/data/dir/tl.gz', [], { nofollow: true }],
    ])
  })

  it('sees a link the router followed vanish before its turn', () => {
    const [dispatch] = recorder()
    const door = new LinkDoor(links({}), dispatch, '/data')
    const followed = spec('/data/t.gz', 'tl.gz')
    expect(door.vanished(followed)).toBe(true)
    expect(door.linkAt(followed)).toBeNull()
    expect(door.vanished(spec('/data/t.gz', 't.gz'))).toBe(false)
  })

  it('lists and stats by the name it is handed', async () => {
    const [dispatch, calls] = recorder()
    const door = new LinkDoor(LINKS, dispatch, '/data')
    expect(await door.readdir('/data/dir')).toEqual(['/data/dir/a', '/data/dir/b'])
    expect((await door.stat('/data/t.gz')).name).toBe('n')
    expect(calls).toEqual([
      ['readdir', '/data/dir', [], {}],
      ['stat', '/data/t.gz', [], {}],
    ])
  })

  it('merges the links standing in a directory for a walker', () => {
    const [dispatch] = recorder()
    const door = new LinkDoor(LINKS, dispatch, '/data')
    expect(door.children('/data/dir/')).toEqual(['/data/dir/tl.gz'])
    expect(door.children('/data/w')).toEqual([])
  })

  it('leads where the table resolves a link, and a loop is ELOOP', () => {
    const [dispatch] = recorder()
    expect(new LinkDoor(LINKS, dispatch, '/data').target('/data/dir/tl.gz')).toBe('/data/t.gz')
    const looped = new LinkDoor(links({ '/data/l': '/data/l' }), dispatch, '/data')
    let caught: unknown = null
    try {
      looped.target('/data/l')
    } catch (err) {
      caught = err
    }
    expect(isDotWalkError(caught) && caught.code).toBe('ELOOP')
  })

  it('is absent without links or a door', () => {
    const [dispatch] = recorder()
    const base: CommandOpts = { stdin: null, flags: {}, filetypeFns: null, cwd: '/' }
    expect(linkDoor(base)).toBeNull()
    expect(linkDoor({ ...base, ns: { links: LINKS } })).toBeNull()
    expect(linkDoor({ ...base, ns: { links: LINKS }, dispatch })?.cwd).toBe('/')
  })
})
