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

import type fs from 'node:fs'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from '@struktoai/mirage-core/test-utils'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { DiskVFS } from '../../../vfs/disk/disk.ts'
import { patchNodeFs } from './fs.ts'
import { Workspace } from '../../../workspace.ts'

type Fs = typeof fs

const requireCjs = createRequire(import.meta.url)

let scratch: string
let restore: (() => void) | null = null

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mirage-os-patch-'))
})

afterEach(() => {
  if (restore !== null) {
    restore()
    restore = null
  }
  rmSync(scratch, { recursive: true, force: true })
})

describe('patchNodeFs — mounted paths', () => {
  it('routes fs.promises.readFile through the workspace', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await ws.shell('echo hello | tee /data/x.txt')
    const text = await fs.promises.readFile('/data/x.txt', 'utf-8')
    expect(text).toBe('hello\n')
    await ws.close()
  })

  it('returns Buffer when no encoding is given', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await fs.promises.writeFile('/data/bin', new Uint8Array([1, 2, 3]))
    const buf = await fs.promises.readFile('/data/bin')
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(Array.from(buf as Buffer)).toEqual([1, 2, 3])
    await ws.close()
  })

  it('writeFile + readdir + unlink + mkdir + rmdir all route through the workspace', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await fs.promises.writeFile('/data/a.txt', 'A')
    await fs.promises.writeFile('/data/b.txt', 'B')
    expect((await fs.promises.readdir('/data')).sort()).toEqual(['a.txt', 'b.txt'])

    await fs.promises.mkdir('/data/sub')
    await fs.promises.writeFile('/data/sub/c.txt', 'C')
    expect((await fs.promises.readdir('/data/sub')).sort()).toEqual(['c.txt'])

    await fs.promises.unlink('/data/a.txt')
    expect((await fs.promises.readdir('/data')).sort()).toEqual(['b.txt', 'sub'])

    await fs.promises.unlink('/data/sub/c.txt')
    await fs.promises.rmdir('/data/sub')
    expect((await fs.promises.readdir('/data')).sort()).toEqual(['b.txt'])

    await ws.close()
  })
})

describe('patchNodeFs — routed calls', () => {
  it('serves every routed spelling on a mount', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await fs.promises.mkdir('/data/a/b', { recursive: true })
    await fs.promises.writeFile('/data/a/b/f.txt', 'hi')
    await fs.promises.appendFile('/data/a/b/f.txt', '!')
    await fs.promises.access('/data/a/b/f.txt')
    await fs.promises.copyFile('/data/a/b/f.txt', '/data/a/g.txt')
    await fs.promises.chmod('/data/a/g.txt', 0o600)
    await fs.promises.truncate('/data/a/g.txt', 2)
    await fs.promises.utimes('/data/a/g.txt', 1_700_000_000, 1_700_000_123)
    await fs.promises.symlink('g.txt', '/data/a/l')
    const st = await fs.promises.stat('/data/a/g.txt')
    expect([st.size, st.mode & 0o777, st.mtimeMs]).toEqual([2, 0o600, 1_700_000_123_000])
    expect((await fs.promises.lstat('/data/a/l')).isSymbolicLink()).toBe(true)
    expect(await fs.promises.readlink('/data/a/l')).toBe('g.txt')
    const typed = await fs.promises.readdir('/data/a', { withFileTypes: true })
    expect(typed.map((d) => [d.name, d.isDirectory(), d.isSymbolicLink()]).sort()).toEqual([
      ['b', true, false],
      ['g.txt', false, false],
      ['l', false, true],
    ])
    expect((await fs.promises.readdir('/data/a', { recursive: true })).sort()).toEqual([
      'b',
      'b/f.txt',
      'g.txt',
      'l',
    ])
    await fs.promises.rename('/data/a/g.txt', '/data/a/h.txt')
    const exists = (p: string): Promise<boolean> =>
      new Promise((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        fs.exists(p, resolve)
      })
    expect(await exists('/data/a/h.txt')).toBe(true)
    await fs.promises.rm('/data/a', { recursive: true })
    expect(await exists('/data/a')).toBe(false)
    await ws.close()
  })

  it('copies between a mount and the host', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const real = join(scratch, 'in.txt')
    writeFileSync(real, 'from the host')

    await fs.promises.copyFile(real, '/data/in.txt')
    await fs.promises.copyFile('/data/in.txt', join(scratch, 'out.txt'))
    expect(await fs.promises.readFile('/data/in.txt', 'utf-8')).toBe('from the host')
    expect(await fs.promises.readFile(join(scratch, 'out.txt'), 'utf-8')).toBe('from the host')
    await ws.close()
  })

  it('copies the stored bytes of a rendered file', async () => {
    const vfs = render(new RAMVFS(), '.tally', () =>
      Promise.resolve(new TextEncoder().encode('rendered')),
    )
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/a.tally', 'stored')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await fs.promises.copyFile('/data/a.tally', '/data/b.tally')
    await fs.promises.copyFile('/data/a.tally', join(scratch, 'a.tally'))
    expect(new TextDecoder().decode(await ws.vfs.read('/data/b.tally', { raw: true }))).toBe(
      'stored',
    )
    expect(await fs.promises.readFile(join(scratch, 'a.tally'), 'utf-8')).toBe('stored')
    await ws.close()
  })

  it('answers in the shapes node does', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    expect(await fs.promises.mkdir('/data/a/b', { recursive: true })).toBe('/data/a')
    expect(await fs.promises.mkdir('/data/a/b', { recursive: true })).toBeUndefined()
    await fs.promises.writeFile('/data/f.txt', 'one')
    await fs.promises.appendFile('/data/f.txt', 'two', { flag: 'w' })
    expect(await fs.promises.readFile('/data/f.txt', 'utf-8')).toBe('two')
    await fs.promises.symlink('f.txt', '/data/l')
    const target = await fs.promises.readlink('/data/l', { encoding: 'buffer' })
    expect(Buffer.isBuffer(target) && target.toString()).toBe('f.txt')
    const big = await fs.promises.lstat('/data/f.txt', { bigint: true })
    expect([big.size, typeof big.mtimeNs, big.isFile()]).toEqual([3n, 'bigint', true])
    expect(typeof (await fs.promises.stat('/data/f.txt', { bigint: true })).ino).toBe('bigint')
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    expect(await promisify(fs.exists)('/data/f.txt')).toBe(true)
    expect(fs.realpathSync.native(scratch)).toBe(realpathSync(scratch))
    expect(() => fs.realpathSync.native('/data/f.txt')).toThrow(
      expect.objectContaining({ code: 'ENOTSUP' }),
    )
    await ws.close()
  })

  it('leaves every spelling to node on a path no mount owns', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const real = join(scratch, 'r.txt')
    writeFileSync(real, 'R')

    await fs.promises.access(real)
    await fs.promises.appendFile(real, 'S')
    expect((await fs.promises.lstat(real)).size).toBe(2)
    await fs.promises.rename(real, `${real}2`)
    expect(fs.readFileSync(`${real}2`, 'utf-8')).toBe('RS')
    expect(fs.existsSync(`${real}2`)).toBe(true)
    await ws.close()
  })
})

describe('patchNodeFs — ledger', () => {
  it('records each call on ws.vfs.records', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await fs.promises.writeFile('/data/x.txt', 'hi')
    await fs.promises.readFile('/data/x.txt')
    expect(ws.vfs.records.map((r) => [r.op, r.path, r.bytes])).toEqual([
      ['write', '/data/x.txt', 2],
      ['read', '/data/x.txt', 2],
    ])
    await ws.close()
  })
})

describe('patchNodeFs — refusals', () => {
  // A hide, a read-only mount and a path rule: both doors ask the
  // dispatcher, so the one refusal comes back through either.
  it.each([
    ['/data/secret.txt', 'read', 'ENOENT'],
    ['/ro/new.txt', 'write', 'EROFS'],
    ['/data/sealed/f.txt', 'read', 'EACCES'],
  ] as const)('%s refuses %s as ws.vfs does', async (path, op, code) => {
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/ro': [new RAMVFS(), MountMode.READ] },
      { mode: MountMode.WRITE },
    )
    await ws.vfs.write('/data/secret.txt', 's')
    await ws.vfs.mkdir('/data/sealed')
    await ws.vfs.write('/data/sealed/f.txt', 'f')
    await ws.setSessionProfile(ws.defaultSessionId, {
      paths: { hide: ['/data/secret.txt'] },
      commands: { deny: [{ reason: 'sealed', paths: ['/data/sealed/*'] }] },
    })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const direct = op === 'read' ? ws.vfs.read(path) : ws.vfs.write(path, 'x')
    const patched = op === 'read' ? fs.promises.readFile(path) : fs.promises.writeFile(path, 'x')
    await expect(direct).rejects.toMatchObject({ code })
    await expect(patched).rejects.toMatchObject({ code })
    await ws.close()
  })
})

describe('patchNodeFs — what a mount cannot serve', () => {
  it.each([
    [
      'rename across the mount edge',
      'EXDEV',
      (fs: Fs) => fs.promises.rename('/data/f.txt', join(scratch, 'x')),
    ],
    ['a hard link', 'EPERM', (fs: Fs) => fs.promises.link('/data/f.txt', '/data/g.txt')],
    ['a descriptor', 'ENOTSUP', (fs: Fs) => fs.promises.open('/data/f.txt')],
    [
      'an exclusive create of a name that is there',
      'EEXIST',
      (fs: Fs) => fs.promises.writeFile('/data/f.txt', 'x', { flag: 'wx' }),
    ],
    [
      'an exclusive append to a name that is there',
      'EEXIST',
      (fs: Fs) => fs.promises.writeFile('/data/f.txt', 'x', { flag: 'ax' }),
    ],
    [
      'a watch, on its first event',
      'ENOTSUP',
      async (fs: Fs) => {
        for await (const _ of fs.promises.watch('/data/f.txt')) return
      },
    ],
    [
      'a watch listener',
      'ENOTSUP',
      (fs: Fs) => Promise.resolve().then(() => fs.watch('/data/f.txt', () => undefined)),
    ],
    ['rm of a directory without recursive', 'EISDIR', (fs: Fs) => fs.promises.rm('/data/d')],
    [
      'a sync spelling',
      'ENOTSUP',
      (fs: Fs) => Promise.resolve().then(() => fs.statSync('/data/f.txt')),
    ],
  ] as const)('refuses %s with %s', async (_label, code, call) => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/f.txt', 'f')
    await ws.vfs.mkdir('/data/d')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    await expect(call(fs)).rejects.toMatchObject({ code })
    await ws.close()
  })

  it('refuses a mount root anywhere in a removal, removing nothing', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/data/d/m': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    await ws.vfs.mkdir('/data/d')
    await ws.vfs.write('/data/d/f.txt', 'f')
    await ws.vfs.write('/data/d/m/g.txt', 'g')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await expect(fs.promises.rm('/data/d', { recursive: true })).rejects.toMatchObject({
      code: 'EBUSY',
      path: '/data/d/m',
    })
    await expect(fs.promises.rm('/data', { recursive: true })).rejects.toMatchObject({
      code: 'EBUSY',
      path: '/data',
    })
    await expect(fs.promises.rmdir('/data/d/m')).rejects.toMatchObject({ code: 'EBUSY' })
    expect(await fs.promises.readFile('/data/d/f.txt', 'utf-8')).toBe('f')
    expect(await fs.promises.readFile('/data/d/m/g.txt', 'utf-8')).toBe('g')
    await ws.close()
  })

  it('answers a refused callback spelling through its callback', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const err = await new Promise((resolve) => {
      fs.link('/data/a', '/data/b', resolve)
    })
    expect(err).toMatchObject({ code: 'EPERM', syscall: 'link', path: '/data/a' })
    await ws.close()
  })
})

describe('patchNodeFs — mirageStat adapter', () => {
  it('fs.promises.stat() returns an object with isFile()/isDirectory() methods', async () => {
    const ws = new Workspace({ '/data': new DiskVFS({ root: scratch }) }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await fs.promises.writeFile('/data/file.txt', 'x')
    await fs.promises.mkdir('/data/dir')

    const fileStat = (await fs.promises.stat('/data/file.txt')) as MirageStatShape
    expect(fileStat.isFile()).toBe(true)
    expect(fileStat.isDirectory()).toBe(false)
    expect(fileStat.size).toBe(1)
    expect(fileStat.mtime).toBeInstanceOf(Date)

    const dirStat = (await fs.promises.stat('/data/dir')) as MirageStatShape
    expect(dirStat.isFile()).toBe(false)
    expect(dirStat.isDirectory()).toBe(true)

    await ws.close()
  })
})

describe('patchNodeFs — fall-through to native fs', () => {
  it('unmounted paths reach the real filesystem', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    const realPath = join(scratch, 'native.txt')
    await fs.promises.writeFile(realPath, 'native-content')
    const text = await fs.promises.readFile(realPath, 'utf-8')
    expect(text).toBe('native-content')
    await ws.close()
  })

  it('a disk root at its own prefix does not re-enter', async () => {
    // Python needs runtime/python/host/host_io for this layout: its
    // patched os answers the disk backend's own physical path. The node
    // backends bind node:fs/promises as ESM, which the patch's swap of
    // the CommonJS fs functions never reaches.
    writeFileSync(join(scratch, 'a.txt'), 'hello')
    const ws = new Workspace(
      { [scratch]: new DiskVFS({ root: scratch }) },
      { mode: MountMode.READ },
    )
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await expect(fs.promises.writeFile(join(scratch, 'b.txt'), 'x')).rejects.toThrow()
    expect(await fs.promises.readdir(scratch)).toEqual(['a.txt'])
    expect(await fs.promises.readFile(join(scratch, 'a.txt'), 'utf-8')).toBe('hello')
    await ws.close()
  })

  it('a single program can mix mounted and unmounted reads', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    const realPath = join(scratch, 'real.txt')
    await fs.promises.writeFile(realPath, 'on-disk')
    await ws.shell('echo virtual | tee /data/v.txt')

    expect(await fs.promises.readFile(realPath, 'utf-8')).toBe('on-disk')
    expect(await fs.promises.readFile('/data/v.txt', 'utf-8')).toBe('virtual\n')
    await ws.close()
  })
})

describe('patchNodeFs — sync methods + restore()', () => {
  it('readFileSync on a mounted path throws (sync not supported)', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    expect(() => fs.readFileSync('/data/anything')).toThrow(/sync fs methods not supported/)
    await ws.close()
  })

  it('callback readFile on a mounted path returns workspace bytes', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await ws.shell('echo cb | tee /data/cb.txt')
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      fs.readFile('/data/cb.txt', (err, data) => {
        if (err) reject(err)
        else resolve(data)
      })
    })
    expect(bytes.toString('utf-8')).toBe('cb\n')
    await ws.close()
  })

  it('restore() leaves fs.promises.readFile working on real files', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const undo = patchNodeFs(ws)
    undo()
    restore = null
    const fs = requireCjs('fs') as Fs
    const realPath = join(scratch, 'after-restore.txt')
    await fs.promises.writeFile(realPath, 'still works')
    expect(await fs.promises.readFile(realPath, 'utf-8')).toBe('still works')
    await ws.close()
  })
})

interface MirageStatShape {
  isFile: () => boolean
  isDirectory: () => boolean
  size: number
  mtime: Date
}
