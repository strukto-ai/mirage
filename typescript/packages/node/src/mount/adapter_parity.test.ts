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

import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { FileStat, FileType, MountMode } from '@struktoai/mirage-core/types'
import { describe, expect, it } from 'vitest'
import { MountCore } from './core.ts'
import { classifyErrno } from './errors.ts'
import { Workspace } from '../workspace.ts'
import { MirageNFS } from '../nfs/delegate.ts'

const HELLO = 'hello world'
// No handle: both cores treat an unknown fd as "apply directly", which
// is python's `fh=None`.
const NO_HANDLE = -1

async function seeded(sizeless: boolean): Promise<Workspace> {
  const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
  await ws.execute(`printf '%s' '${HELLO}' > /a.txt`)
  await ws.execute('mkdir /sub && printf nested > /sub/b.txt')
  if (sizeless) {
    // Stands in for an API-backed resource whose byte length is unknown
    // until the content is fetched.
    const realStat = ws.fs.stat.bind(ws.fs)
    ws.fs.stat = async (path: string) => {
      const row = await realStat(path)
      if (row.type === FileType.DIRECTORY) return row
      return new FileStat({ name: row.name, type: row.type, size: null })
    }
  }
  return ws
}

/**
 * Make one op refuse, until the returned handle heals it.
 *
 * The three bugs these failure cases exist for are all on paths where
 * the backend refuses *after* the client was told the write succeeded,
 * so a battery built only on happy paths could not see them -- which is
 * how all three lived in python after Codex found them here.
 */
function failing(ws: Workspace, op: 'writeFile' | 'unlink'): { heal: () => void } {
  const real = ws.fs[op].bind(ws.fs) as (...args: never[]) => Promise<unknown>
  ws.fs[op] = (() => Promise.reject(new Error('permission denied'))) as never
  return {
    heal: () => {
      ws.fs[op] = real as never
    },
  }
}

/** The bytes a workspace actually stored, as text. */
async function stored(ws: Workspace, path: string): Promise<string> {
  return Buffer.from(await ws.fs.readFile(path, { raw: true })).toString()
}

/**
 * The two adapters over identical, independent workspaces.
 *
 * One tree cannot serve both: every case mutates it, and the point is to
 * ask both adapters the same question of the same starting state.
 */
class Pair {
  constructor(
    readonly core: MountCore,
    readonly nfs: MirageNFS,
    readonly fuseWs: Workspace,
    readonly nfsWs: Workspace,
  ) {}

  static async make(sizeless = false): Promise<Pair> {
    const fuseWs = await seeded(sizeless)
    const nfsWs = await seeded(sizeless)
    return new Pair(new MountCore(fuseWs.fs), new MirageNFS(nfsWs.fs), fuseWs, nfsWs)
  }

  /** Resolve a path to a fileid the way a client walks it. */
  async nfsId(...parts: string[]): Promise<number> {
    let fileid = this.nfs.rootDir()
    for (const part of parts) fileid = await this.nfs.lookup(fileid, part)
    return fileid
  }

  /** [isDir, isSymlink, size] for a path, nfs side. */
  async nfsAttrs(...parts: string[]): Promise<[boolean, boolean, number]> {
    const attrs = await this.nfs.getattr(await this.nfsId(...parts))
    return [attrs.isDir, attrs.isSymlink, attrs.size]
  }

  /** [isDir, isSymlink, size] for a path, fuse side. */
  async fuseAttrs(path: string): Promise<[boolean, boolean, number]> {
    const entry = await this.core.getattr(path)
    const mode = entry.mode
    // S_IFMT masks off the permission bits; 0o040000 is a directory and
    // 0o120000 a symlink, the same constants python's stat module names.
    const kind = mode & 0o170000
    return [kind === 0o040000, kind === 0o120000, entry.size]
  }
}

/** The errno an adapter's failure classifies to, through one table. */
async function errnoOf(call: () => Promise<unknown>): Promise<number> {
  try {
    await call()
  } catch (err) {
    return classifyErrno(err)
  }
  throw new Error('expected the call to fail')
}

describe('fuse/nfs adapter parity', () => {
  it('agrees on a file', async () => {
    const pair = await Pair.make()
    expect(await pair.fuseAttrs('/a.txt')).toEqual(await pair.nfsAttrs('a.txt'))
    expect(await pair.nfsAttrs('a.txt')).toEqual([false, false, HELLO.length])
  })

  it('agrees on a directory', async () => {
    const pair = await Pair.make()
    expect(await pair.fuseAttrs('/sub')).toEqual(await pair.nfsAttrs('sub'))
    expect((await pair.nfsAttrs('sub'))[0]).toBe(true)
  })

  it('classifies a missing path to the same errno', async () => {
    const pair = await Pair.make()
    expect(await errnoOf(() => pair.core.getattr('/nope.txt'))).toBe(
      await errnoOf(() => pair.nfsId('nope.txt')),
    )
  })

  it('agrees on readdir names', async () => {
    // The fuse core prepends "." and ".." because libfuse's readdir must
    // emit them; NFSv3 carries them in the reply header instead, so the
    // comparison is over real entries.
    const pair = await Pair.make()
    const fuse = (await pair.core.readdir('/')).filter((n) => n !== '.' && n !== '..')
    const nfs = (await pair.nfs.readdir(pair.nfs.rootDir())).map((e) => e.name).sort()
    expect(fuse).toEqual(nfs)
  })

  it('agrees on a whole-file read', async () => {
    const pair = await Pair.make()
    const fuse = await pair.core.read('/a.txt', NO_HANDLE, 0, HELLO.length)
    const nfs = await pair.nfs.read(await pair.nfsId('a.txt'), 0, HELLO.length)
    expect(Buffer.from(fuse).toString()).toBe(HELLO)
    expect(Buffer.from(nfs).toString()).toBe(HELLO)
  })

  it('agrees on an offset read', async () => {
    const pair = await Pair.make()
    const fuse = await pair.core.read('/a.txt', NO_HANDLE, 6, 5)
    const nfs = await pair.nfs.read(await pair.nfsId('a.txt'), 6, 5)
    expect(Buffer.from(fuse).toString()).toBe('world')
    expect(Buffer.from(nfs).toString()).toBe('world')
  })

  it('makes a write readable before it is stored, on both', async () => {
    // The adapters buffer differently -- fuse merges through a handle,
    // nfs holds a per-fileid buffer flushed on an idle timer -- and the
    // point of the nfs overlay is that a client cannot tell.
    const pair = await Pair.make()
    await pair.core.write('/a.txt', NO_HANDLE, Buffer.from('HELLO'), 0)
    const fileid = await pair.nfsId('a.txt')
    await pair.nfs.write(fileid, 0, Buffer.from('HELLO'))

    const fuse = await pair.core.read('/a.txt', NO_HANDLE, 0, HELLO.length)
    const nfs = await pair.nfs.read(fileid, 0, HELLO.length)
    expect(Buffer.from(fuse).toString()).toBe(Buffer.from(nfs).toString())
    expect(await pair.fuseAttrs('/a.txt')).toEqual(await pair.nfsAttrs('a.txt'))
  })

  it('grows a file the same way on a write past the end', async () => {
    const pair = await Pair.make()
    await pair.core.write('/a.txt', NO_HANDLE, Buffer.from('!'), HELLO.length)
    const fileid = await pair.nfsId('a.txt')
    await pair.nfs.write(fileid, HELLO.length, Buffer.from('!'))
    expect((await pair.fuseAttrs('/a.txt'))[2]).toBe((await pair.nfsAttrs('a.txt'))[2])
    expect((await pair.nfsAttrs('a.txt'))[2]).toBe(HELLO.length + 1)
  })

  it('agrees on symlink and readlink', async () => {
    // libfuse passes the pointee first, so the two cores name their
    // arguments in opposite orders; both store the target verbatim.
    const pair = await Pair.make()
    await pair.core.symlink('a.txt', '/lnk')
    await pair.nfs.symlink(pair.nfs.rootDir(), 'lnk', 'a.txt')

    expect(pair.core.readlink('/lnk')).toBe(await pair.nfs.readlink(await pair.nfsId('lnk')))
    expect((await pair.fuseAttrs('/lnk'))[1]).toBe(true)
    expect((await pair.nfsAttrs('lnk'))[1]).toBe(true)
  })

  it('agrees on mkdir', async () => {
    const pair = await Pair.make()
    await pair.core.mkdir('/fresh')
    await pair.nfs.mkdir(pair.nfs.rootDir(), 'fresh')
    expect(await pair.fuseAttrs('/fresh')).toEqual(await pair.nfsAttrs('fresh'))
  })

  it('agrees on rename', async () => {
    const pair = await Pair.make()
    await pair.core.rename('/a.txt', '/renamed.txt')
    const root = pair.nfs.rootDir()
    await pair.nfs.rename(root, 'a.txt', root, 'renamed.txt')

    expect(await pair.fuseAttrs('/renamed.txt')).toEqual(await pair.nfsAttrs('renamed.txt'))
    expect(await errnoOf(() => pair.core.getattr('/a.txt'))).toBe(
      await errnoOf(() => pair.nfsId('a.txt')),
    )
  })

  it('agrees on unlink', async () => {
    const pair = await Pair.make()
    await pair.core.unlink('/a.txt')
    await pair.nfs.remove(pair.nfs.rootDir(), 'a.txt')
    expect(await errnoOf(() => pair.core.getattr('/a.txt'))).toBe(
      await errnoOf(() => pair.nfsId('a.txt')),
    )
  })

  it('agrees on truncate', async () => {
    const pair = await Pair.make()
    await pair.core.truncate('/a.txt', 5)
    await pair.nfs.setSize(await pair.nfsId('a.txt'), 5)
    expect(await pair.fuseAttrs('/a.txt')).toEqual(await pair.nfsAttrs('a.txt'))
    const fuse = await pair.core.read('/a.txt', NO_HANDLE, 0, 99)
    const nfs = await pair.nfs.read(await pair.nfsId('a.txt'), 0, 99)
    expect(Buffer.from(fuse).toString()).toBe(HELLO.slice(0, 5))
    expect(Buffer.from(nfs).toString()).toBe(HELLO.slice(0, 5))
  })

  it('stats a size-unknown file as zero on both', async () => {
    // Neither adapter may invent a size it cannot know.
    const pair = await Pair.make(true)
    expect((await pair.fuseAttrs('/a.txt'))[2]).toBe(0)
    expect((await pair.nfsAttrs('a.txt'))[2]).toBe(0)
  })

  it('answers the same size-unknown bytes when they are asked for', async () => {
    // Both adapters answer a READ with the real content: neither one
    // truncates to the size it stated. The size-unknown limitation is
    // not that nfs reads empty here -- it is that a client never asks,
    // which is the next case.
    const pair = await Pair.make(true)
    const fd = await pair.core.open('/a.txt')
    const fuse = await pair.core.read('/a.txt', fd, 0, HELLO.length)
    const nfs = await pair.nfs.read(await pair.nfsId('a.txt'), 0, HELLO.length)
    expect(Buffer.from(fuse).toString()).toBe(HELLO)
    expect(Buffer.from(nfs).toString()).toBe(HELLO)
  })

  it('diverges on the post-open size, and only there', async () => {
    // FUSE hydrates on OPEN, so the fstat that follows reports the real
    // length and every size-driven tool reads the whole file. NFSv3 has
    // no OPEN procedure to hang that on, so the size stays 0 and the
    // client stops there -- which is why the file reads empty through a
    // real mount (`sizeless_reads_empty` in integ/nfs/truth_nfs.json)
    // although the adapter above would have answered the bytes. This is
    // the limitation `checkSizesNfs` warns about at mount time; if this
    // case ever fails because the two agree, the divergence was closed
    // and the warning and its docs should go with it.
    const pair = await Pair.make(true)
    const fd = await pair.core.open('/a.txt')
    expect((await pair.core.fgetattr('/a.txt', fd)).size).toBe(HELLO.length)
    expect((await pair.nfsAttrs('a.txt'))[2]).toBe(0)
  })

  // --- failure cases ----------------------------------------------
  //
  // The happy-path cases above cannot see a bug on a path where the
  // backend refuses AFTER the client was told the write succeeded,
  // which is precisely where both adapters were wrong. Three were
  // found here and all three were in python too, and nothing in this
  // file would have said so.

  it('loses no write the store refused, on either adapter', async () => {
    const pair = await Pair.make()
    const fuseFail = failing(pair.fuseWs, 'writeFile')
    const nfsFail = failing(pair.nfsWs, 'writeFile')

    const fh = await pair.core.open('/a.txt')
    await pair.core.write('/a.txt', fh, Buffer.from('NEW'), 0)
    await expect(pair.core.flush('/a.txt', fh)).rejects.toThrow(/denied/)

    const nfsId = await pair.nfsId('a.txt')
    await pair.nfs.write(nfsId, 0, Buffer.from('NEW'))
    await expect(pair.nfs.flush(nfsId)).rejects.toThrow(/denied/)

    // Both still hold the bytes, so a retry against a healthy backend
    // stores them. Losing them is the failure: every one was answered
    // as durable, and the client will not send them again.
    fuseFail.heal()
    nfsFail.heal()
    await pair.core.flush('/a.txt', fh)
    await pair.nfs.flush(nfsId)

    expect(await stored(pair.fuseWs, '/a.txt')).toBe('NEWlo world')
    expect(await stored(pair.nfsWs, '/a.txt')).toBe('NEWlo world')
  })

  it('loses no write a refused remove rolled back', async () => {
    const pair = await Pair.make()
    const nfsFail = failing(pair.nfsWs, 'unlink')
    failing(pair.fuseWs, 'unlink')

    const nfsId = await pair.nfsId('a.txt')
    await pair.nfs.write(nfsId, 0, Buffer.from('NEW'))
    await expect(pair.nfs.remove(pair.nfs.rootDir(), 'a.txt')).rejects.toThrow(/denied/)
    await expect(pair.core.unlink('/a.txt')).rejects.toThrow(/denied/)

    // The file survived on both sides, so the writes acknowledged
    // against it must survive too; dropping them turned a failed
    // delete into a silent rollback of a successful write.
    nfsFail.heal()
    await pair.nfs.flush(nfsId)

    expect(await stored(pair.nfsWs, '/a.txt')).toBe('NEWlo world')
    expect(await stored(pair.fuseWs, '/a.txt')).toBe(HELLO)
  })

  it('refuses an exclusive create on the tier that has to enforce it', async () => {
    // No fuse twin, and that asymmetry is the point: the kernel
    // resolves O_EXCL above a FUSE filesystem, so MountCore is never
    // asked. NFSv3 carries the mode on the wire, so the server is the
    // only thing that can refuse -- and routing it to the plain
    // create, which truncates, is what emptied the file the caller was
    // told it had not touched.
    const pair = await Pair.make()

    await expect(pair.nfs.createExclusive(pair.nfs.rootDir(), 'a.txt')).rejects.toThrow(/exists/i)

    expect(await stored(pair.nfsWs, '/a.txt')).toBe(HELLO)
  })
})
