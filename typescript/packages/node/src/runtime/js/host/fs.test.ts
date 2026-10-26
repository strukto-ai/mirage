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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
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

  it('reports Node error metadata for open and descriptor failures', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    await expect(fs.promises.open('/data/missing')).rejects.toMatchObject({
      code: 'ENOENT',
      syscall: 'open',
      path: '/data/missing',
      message: "ENOENT: no such file or directory, open '/data/missing'",
    })
    const handle = await fs.promises.open('/data/file', 'w')
    await expect(handle.read(Buffer.alloc(1))).rejects.toMatchObject({
      code: 'EBADF',
      syscall: 'read',
      message: 'EBADF: bad file descriptor, read',
    })
    await handle.close()
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

  it('leaves a Buffer path to node beside a mounted one', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const real = join(scratch, 'in.txt')
    writeFileSync(real, 'from the host')

    await fs.promises.copyFile(Buffer.from(real), '/data/in.txt')
    await fs.promises.copyFile('/data/in.txt', Buffer.from(join(scratch, 'out.txt')))
    expect(await fs.promises.readFile('/data/in.txt', 'utf-8')).toBe('from the host')
    expect(readFileSync(join(scratch, 'out.txt'), 'utf-8')).toBe('from the host')
    await expect(fs.promises.rename(Buffer.from(real), '/data/x')).rejects.toMatchObject({
      code: 'EXDEV',
    })
    await ws.close()
  })

  it('copies exclusively onto the host, refusing a dangling link', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/f.txt', 'f')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const link = join(scratch, 'link')
    symlinkSync(join(scratch, 'target'), link)
    const { COPYFILE_EXCL } = fs.constants

    await expect(fs.promises.copyFile('/data/f.txt', link, COPYFILE_EXCL)).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(existsSync(join(scratch, 'target'))).toBe(false)
    await fs.promises.copyFile('/data/f.txt', join(scratch, 'new.txt'), COPYFILE_EXCL)
    expect(readFileSync(join(scratch, 'new.txt'), 'utf-8')).toBe('f')
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

  it('leaves a relative path to node under a root mount', async () => {
    // A mount made at / claims every absolute path, and a relative one
    // still names the process's working directory.
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await fs.promises.writeFile(relative(process.cwd(), join(scratch, 'here.txt')), 'host')
    await fs.promises.writeFile('/there.txt', 'mount')
    expect(readFileSync(join(scratch, 'here.txt'), 'utf8')).toBe('host')
    expect(new TextDecoder().decode(await ws.vfs.read('/there.txt'))).toBe('mount')
    await ws.close()
  })

  it('takes null for options, as node does', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await fs.promises.writeFile('/data/f.txt', 'one', null)
    await fs.promises.appendFile('/data/f.txt', new Uint8Array([33]), null)
    expect(await fs.promises.readFile('/data/f.txt', { encoding: null })).toEqual(
      Buffer.from('one!'),
    )
    await fs.promises.symlink('f.txt', '/data/l')
    expect(await fs.promises.readlink('/data/l', null)).toBe('f.txt')
    const size = await new Promise((resolve, reject) => {
      fs.stat('/data/f.txt', null as never, (err, st) => {
        if (err) reject(err)
        else resolve(st.size)
      })
    })
    expect(size).toBe(4)
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

  it('changes a link itself, never its target, through the l calls', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/a.txt', 'hello')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const before = (await fs.promises.stat('/data/a.txt')).mtimeMs
    await fs.promises.symlink('a.txt', '/data/link')
    await fs.promises.lchown('/data/link', 4242, 4343)
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    await fs.promises.lchmod('/data/link', 0o600)
    await promisify(fs.lutimes)('/data/link', 100, 200)
    const link = await fs.promises.lstat('/data/link')
    // No POSIX system consults the bits on a symlink, so its mode stays.
    expect([link.uid, link.gid, link.mode & 0o777, link.isSymbolicLink()]).toEqual([
      4242,
      4343,
      0o777,
      true,
    ])
    expect(link.mtimeMs).toBe(200_000)
    expect((await fs.promises.stat('/data/a.txt')).mtimeMs).toBe(before)
    await ws.close()
  })

  it('changes the mode and owner of the file a descriptor names', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/a.txt', 'hello')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const handle = await fs.promises.open('/data/a.txt', 'r+')
    await handle.chmod(0o600)
    await handle.chown(4242, 4343)
    await handle.close()
    const fd = await promisify(fs.open)('/data/a.txt', 'r+')
    await promisify(fs.fchmod)(fd, 0o640)
    await promisify(fs.fchown)(fd, 4244, 4345)
    await promisify(fs.close)(fd)
    const st = await fs.promises.stat('/data/a.txt')
    expect([st.mode & 0o777, st.uid, st.gid]).toEqual([0o640, 4244, 4345])
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

describe('patchNodeFs — descriptors', () => {
  it('refreshes another descriptor after append and preserves an unlinked stat', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    await fs.promises.writeFile('/data/f', 'abc')
    const reader = await fs.promises.open('/data/f', 'r')
    expect((await reader.read(Buffer.alloc(3))).bytesRead).toBe(3)
    const writer = await fs.promises.open('/data/f', 'a')
    await writer.write('DEF')
    await writer.close()
    const { buffer, bytesRead } = await reader.read(Buffer.alloc(3))
    expect(buffer.toString('utf8', 0, bytesRead)).toBe('DEF')
    await expect(reader.read(Buffer.alloc(3), 0, -1, 0)).rejects.toMatchObject({
      code: 'ERR_OUT_OF_RANGE',
    })
    await expect(reader.read(Buffer.alloc(3), 0, 1, -5)).rejects.toMatchObject({
      code: 'ERR_OUT_OF_RANGE',
    })
    await fs.promises.unlink('/data/f')
    expect((await reader.stat()).nlink).toBe(0)
    await reader.close()
    await ws.close()
  })
  it('leaves an appending descriptor past what it wrote', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    await fs.promises.writeFile('/data/f', 'abc')
    const handle = await fs.promises.open('/data/f', 'a+')
    await handle.write('X')
    expect((await handle.read(Buffer.alloc(8))).bytesRead).toBe(0)
    await handle.close()
    expect(await fs.promises.readFile('/data/f', 'utf-8')).toBe('abcX')
    await ws.close()
  })
  it('writes nothing for an append that cannot find its end', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    await fs.promises.writeFile('/data/f', 'abc')
    const handle = await fs.promises.open('/data/f', 'a')
    ws.policies.add({
      preVfs: (ctx) => (ctx.call.name === 'stat' ? { kind: 'deny', reason: 'no stat' } : null),
    })
    await expect(handle.write('X')).rejects.toMatchObject({ code: 'EACCES' })
    await handle.close()
    expect(new TextDecoder().decode(await ws.vfs.read('/data/f'))).toBe('abc')
    await ws.close()
  })
  it('lands a write made while a sync is out', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const handle = await fs.promises.open('/data/f.txt', 'w')
    await handle.write('a')
    const syncing = handle.sync()
    await handle.write('b')
    await syncing
    await handle.close()
    expect(await fs.promises.readFile('/data/f.txt', 'utf-8')).toBe('ab')
    await ws.close()
  })

  it('leaves the position where it was across positioned reads', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    await fs.promises.writeFile('/data/f.txt', 'abcdefgh')
    const handle = await fs.promises.open('/data/f.txt', 'r')
    await Promise.all([
      handle.read(Buffer.alloc(2), 0, 2, 3),
      handle.read(Buffer.alloc(2), 0, 2, 6),
    ])
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(2), 0, 2, null)
    expect(buffer.toString('utf8', 0, bytesRead)).toBe('ab')
    await handle.close()
    await ws.close()
  })

  describe.each([false, true])('retained descriptor (detached=%s)', (detached) => {
    it.each(['hide', 'deny', 'pre', 'post'] as const)(
      'rechecks %s without consuming bytes or rereading the backend',
      async (restriction) => {
        const path = '/data/retained.txt'
        const vfs = new RAMVFS()
        const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })
        await ws.vfs.write(path, 'abcdef')
        const read = vi.spyOn(vfs, 'read')
        let refuse = false
        ws.policies.add({
          preVfs: (ctx) =>
            restriction === 'pre' && refuse && ctx.call.name === 'read'
              ? { kind: 'deny', reason: 'sealed' }
              : null,
          postVfs: (ctx) =>
            restriction === 'post' && refuse && ctx.call.name === 'read'
              ? { kind: 'deny', reason: 'sealed' }
              : null,
        })
        restore = patchNodeFs(ws)
        const fs = requireCjs('fs') as Fs
        const handle = await fs.promises.open(path, 'r')
        try {
          const first = await handle.read(Buffer.alloc(2), 0, 2, null)
          expect(first.buffer.toString()).toBe('ab')
          if (detached) await fs.promises.unlink(path)
          const fetched = read.mock.calls.length
          if (restriction === 'hide' || restriction === 'deny') {
            await ws.setSessionProfile(
              ws.defaultSessionId,
              restriction === 'hide'
                ? { paths: { hide: [path] } }
                : { commands: { deny: [{ reason: 'sealed', paths: [path] }] } },
            )
          }
          refuse = true
          const denied = Buffer.alloc(2, 90)
          await expect(handle.read(denied, 0, 2, null)).rejects.toMatchObject({
            code: restriction === 'hide' ? 'ENOENT' : 'EACCES',
          })
          expect(denied.toString()).toBe('ZZ')
          expect(read).toHaveBeenCalledTimes(fetched)
          refuse = false
          await ws.setSessionProfile(ws.defaultSessionId, {})
          const next = await handle.read(Buffer.alloc(2), 0, 2, null)
          expect(next.buffer.toString()).toBe('cd')
          expect(read).toHaveBeenCalledTimes(fetched)
        } finally {
          await handle.close()
          await ws.close()
        }
      },
    )
  })

  it('lets an open file go under a policy that refuses reads', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    await fs.promises.writeFile('/data/f.txt', 'body')
    ws.policies.add({
      preVfs: (ctx) => (ctx.call.name === 'read' ? { kind: 'deny', reason: 'write-only' } : null),
    })
    const handle = await fs.promises.open('/data/f.txt', 'w')
    await fs.promises.unlink('/data/f.txt')
    await handle.close()
    expect(await ws.vfs.exists('/data/f.txt')).toBe(false)
    await ws.close()
  })

  it('fails the reads of an open file whose bytes a policy refused as its name went', async () => {
    // The removal goes ahead, but the bytes it could not keep are not an
    // empty file: the reads after it report the refusal.
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    await fs.promises.writeFile('/data/f.txt', 'body')
    const handle = await fs.promises.open('/data/f.txt', 'r')
    ws.policies.add({
      preVfs: (ctx) => (ctx.call.name === 'read' ? { kind: 'deny', reason: 'no reads' } : null),
    })
    await fs.promises.unlink('/data/f.txt')
    await expect(handle.read(Buffer.alloc(4), 0, 4, 0)).rejects.toThrow()
    await handle.close()
    expect(await ws.vfs.exists('/data/f.txt')).toBe(false)
    await ws.close()
  })

  it('keeps the rendering of a removed file for a reader beside a writer', async () => {
    // A writable open beside it reads the stored bytes, and the reader still
    // sees what the mount renders, as it did before the removal.
    const vfs = render(new RAMVFS(), '.tally', () =>
      Promise.resolve(new TextEncoder().encode('rendered')),
    )
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/b.tally', 'stored')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const reader = await fs.promises.open('/data/b.tally', 'r')
    const writer = await fs.promises.open('/data/b.tally', 'r+')
    await fs.promises.unlink('/data/b.tally')
    const seen = await reader.read(Buffer.alloc(8), 0, 8, 0)
    const own = await writer.read(Buffer.alloc(6), 0, 6, 0)
    expect(seen.buffer.toString('utf8', 0, seen.bytesRead)).toBe('rendered')
    expect(own.buffer.toString('utf8', 0, own.bytesRead)).toBe('stored')
    await reader.close()
    await writer.close()
    await ws.close()
  })

  it('leaves a writer its stored bytes when the rendering fails', async () => {
    // Only the reader of the rendering reports it could not be read.
    const vfs = render(new RAMVFS(), '.tally', () => Promise.reject(new Error('no rendering')))
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/b.tally', 'stored')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const reader = await fs.promises.open('/data/b.tally', 'r')
    const writer = await fs.promises.open('/data/b.tally', 'r+')
    await fs.promises.unlink('/data/b.tally')
    const own = await writer.read(Buffer.alloc(6), 0, 6, 0)
    expect(own.buffer.toString('utf8', 0, own.bytesRead)).toBe('stored')
    await expect(reader.read(Buffer.alloc(6), 0, 6, 0)).rejects.toThrow()
    await reader.close()
    await writer.close()
    await ws.close()
  })

  it('leaves a reader its rendering beside a write-only handle', async () => {
    // The writer lands on the stored bytes, not on the rendering the reader
    // keeps.
    const vfs = render(new RAMVFS(), '.tally', () =>
      Promise.resolve(new TextEncoder().encode('rendered')),
    )
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/b.tally', 'stored')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const reader = await fs.promises.open('/data/b.tally', 'r')
    const writer = await fs.promises.open('/data/b.tally', 'w')
    await fs.promises.unlink('/data/b.tally')
    await writer.write('X', 0)
    await writer.sync()
    const seen = await reader.read(Buffer.alloc(8), 0, 8, 0)
    expect(seen.buffer.toString('utf8', 0, seen.bytesRead)).toBe('rendered')
    await reader.close()
    await writer.close()
    await ws.close()
  })

  it('waits out a removal an open races, then finds the file gone', async () => {
    // The removal reads what its open handles keep; an open that arrives
    // while that read is out waits for it, as the kernel orders an open
    // and an unlink of one name.
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    await fs.promises.writeFile('/data/f.txt', 'hello')
    let gated = false
    let reading = (): void => undefined
    let release = (): void => undefined
    const started = new Promise<void>((resolve) => (reading = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    ws.policies.add({
      preVfs: async (ctx) => {
        if (gated && ctx.call.name === 'read') {
          reading()
          await gate
        }
        return null
      },
    })
    const reader = await fs.promises.open('/data/f.txt', 'r')
    gated = true
    const removing = fs.promises.unlink('/data/f.txt')
    await started
    const late = fs.promises.open('/data/f.txt', 'r+')
    gated = false
    release()
    await removing
    await expect(late).rejects.toMatchObject({ code: 'ENOENT' })
    await reader.close()
    expect(await ws.vfs.exists('/data/f.txt')).toBe(false)
    await ws.close()
  })

  it('keeps a handle through a rename onto its own name', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    await fs.promises.writeFile('/data/a.txt', 'hello')
    const handle = await fs.promises.open('/data/a.txt', 'r+')
    await handle.write('J', 0)
    await fs.promises.rename('/data/a.txt', '/data/a.txt')
    await handle.close()
    expect(await fs.promises.readFile('/data/a.txt', 'utf-8')).toBe('Jello')
    await ws.close()
  })
})

describe('patchNodeFs — ledger', () => {
  it('records each call on ws.vfs.records', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    // A write opens the file, which creates it, and its close lands the
    // bytes, as an open, a write and a close do on a kernel mount.
    await fs.promises.writeFile('/data/x.txt', 'hi')
    await fs.promises.readFile('/data/x.txt')
    expect(ws.vfs.records.map((r) => [r.op, r.path, r.bytes])).toEqual([
      ['create', '/data/x.txt', 0],
      ['pwrite', '/data/x.txt', 2],
      ['read', '/data/x.txt', 2],
    ])
    await ws.close()
  })
})

describe('patchNodeFs — refusals', () => {
  // A hide, a read-only mount and a path rule: both entry points ask the
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

  it('answers a hidden mount root as absent', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/vault': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    await ws.vfs.write('/vault/v.txt', 'v')
    await ws.setSessionProfile(ws.defaultSessionId, { paths: { hide: ['/vault'] } })
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    expect(fs.existsSync('/data')).toBe(true)
    expect(fs.existsSync('/data/.')).toBe(true)
    expect(fs.existsSync('/data/missing/..')).toBe(false)
    expect(fs.existsSync('/vault')).toBe(false)
    await expect(fs.promises.rmdir('/vault')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.promises.rm('/vault', { recursive: true })).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await ws.close()
  })
})

describe('patchNodeFs — calls node makes on its own', () => {
  // d/a.txt, d/sub/b.txt, a link at /data/link to d/a.txt and one at
  // d/sub/up to its parent.
  const world = async (): Promise<[Workspace, Fs]> => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.mkdir('/data/d')
    await ws.vfs.mkdir('/data/d/sub')
    await ws.vfs.write('/data/d/a.txt', 'a')
    await ws.vfs.write('/data/d/sub/b.txt', 'b')
    await ws.vfs.symlink('/data/link', 'd/a.txt')
    await ws.vfs.symlink('/data/d/sub/up', '..')
    restore = patchNodeFs(ws)
    return [ws, requireCjs('fs') as Fs]
  }
  const names = async (items: AsyncIterable<unknown>): Promise<string[]> => {
    const out: string[] = []
    for await (const item of items) out.push(String(item))
    return out.sort()
  }

  it('realpath follows each link in turn, as realpath(3) does', async () => {
    const [ws, fs] = await world()
    expect(await fs.promises.realpath('/data/link')).toBe('/data/d/a.txt')
    expect(await fs.promises.realpath('/data/d/sub/up/a.txt')).toBe('/data/d/a.txt')
    expect(await fs.promises.realpath('/data/d/sub/up/../d/./a.txt')).toBe('/data/d/a.txt')
    expect(Buffer.isBuffer(await fs.promises.realpath('/data/link', { encoding: 'buffer' }))).toBe(
      true,
    )
    expect(await promisify(fs.realpath)('/data/link')).toBe('/data/d/a.txt')
    await expect(fs.promises.realpath('/data/nope/x')).rejects.toMatchObject({
      code: 'ENOENT',
      syscall: 'realpath',
      path: '/data/nope/x',
    })
    await expect(fs.promises.realpath('/data/d/a.txt/x')).rejects.toMatchObject({
      code: 'ENOTDIR',
      syscall: 'realpath',
    })
    await ws.close()
  })

  it('mkdtemp makes a new directory under its prefix', async () => {
    const [ws, fs] = await world()
    const made = await fs.promises.mkdtemp('/data/tmp-')
    expect(made).toMatch(/^\/data\/tmp-[A-Za-z0-9]{6}$/)
    expect((await fs.promises.stat(made)).isDirectory()).toBe(true)
    expect(await fs.promises.mkdtemp('/data/tmp-')).not.toBe(made)
    await expect(fs.promises.mkdtemp('/data/nope/x-')).rejects.toMatchObject({
      code: 'ENOENT',
      syscall: 'mkdtemp',
    })
    await ws.close()
  })

  it.skipIf(!('mkdtempDisposable' in (requireCjs('fs') as Fs).promises))(
    'mkdtempDisposable removes what it made',
    async () => {
      const [ws, fs] = await world()
      const made = await (
        fs.promises as unknown as {
          mkdtempDisposable(prefix: string): Promise<{ path: string; remove(): Promise<void> }>
        }
      ).mkdtempDisposable('/data/dt-')
      expect((await fs.promises.stat(made.path)).isDirectory()).toBe(true)
      await made.remove()
      expect(await ws.vfs.exists(made.path)).toBe(false)
      await ws.close()
    },
  )

  it('opendir hands out the entries as a node Dir does', async () => {
    const [ws, fs] = await world()
    const dir = await fs.promises.opendir('/data/d')
    const seen: string[] = []
    for await (const entry of dir)
      seen.push(`${entry.name}:${String(entry.isDirectory())}:${entry.parentPath}`)
    expect(seen.sort()).toEqual(['a.txt:false:/data/d', 'sub:true:/data/d'])
    expect(dir.path).toBe('/data/d')
    await expect(dir.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' })
    const again = await promisify(fs.opendir)('/data/d')
    expect(again.readSync()?.name).toMatch(/^(a\.txt|sub)$/)
    await again.close()
    await expect(again.close()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' })
    await expect(fs.promises.opendir('/data/nope')).rejects.toMatchObject({
      code: 'ENOENT',
      syscall: 'opendir',
    })
    await ws.close()
  })

  it('glob matches with the matcher node uses', async () => {
    const [ws, fs] = await world()
    expect(await names(fs.promises.glob('/data/d/**/*.txt'))).toEqual([
      '/data/d/a.txt',
      '/data/d/sub/b.txt',
    ])
    expect(await names(fs.promises.glob('**/*.txt', { cwd: '/data/d' }))).toEqual([
      'a.txt',
      'sub/b.txt',
    ])
    const pruned = fs.promises.glob('**', {
      cwd: '/data/d',
      exclude: (path: unknown) => String(path).endsWith('sub'),
    })
    expect(await names(pruned)).toEqual(['.', 'a.txt'])
    expect(
      await names(fs.promises.glob('**/*.txt', { cwd: '/data/d', exclude: ['sub/**'] })),
    ).toEqual(['a.txt'])
    expect(await names(fs.promises.glob('/data/zz/*'))).toEqual([])
    const typed: string[] = []
    for await (const entry of fs.promises.glob('*', { cwd: '/data/d', withFileTypes: true }))
      typed.push(`${entry.name}:${String(entry.isDirectory())}`)
    expect(typed.sort()).toEqual(['a.txt:false', 'sub:true'])
    expect(await promisify(fs.glob)('*.txt', { cwd: '/data/d' })).toEqual(['a.txt'])
    await ws.close()
  })

  it('cp copies a file and a tree as node itself does', async () => {
    const [ws, fs] = await world()
    await fs.promises.cp('/data/d/a.txt', '/data/c.txt')
    expect(await fs.promises.readFile('/data/c.txt', 'utf-8')).toBe('a')
    await fs.promises.cp('/data/d', '/data/e', { recursive: true })
    expect((await fs.promises.readdir('/data/e', { recursive: true })).sort()).toEqual([
      'a.txt',
      'sub',
      'sub/b.txt',
      'sub/up',
    ])
    // A relative link's target is resolved against where it was.
    expect(await fs.promises.readlink('/data/e/sub/up')).toBe('/data/d')
    await fs.promises.cp('/data/d', '/data/f', {
      recursive: true,
      filter: (src: string) => !src.endsWith('b.txt'),
    })
    expect((await fs.promises.readdir('/data/f', { recursive: true })).sort()).toEqual([
      'a.txt',
      'sub',
      'sub/up',
    ])
    await fs.promises.cp('/data/d/a.txt', '/data/c.txt', { force: false })
    await expect(
      fs.promises.cp('/data/d/a.txt', '/data/c.txt', { force: false, errorOnExist: true }),
    ).rejects.toMatchObject({ code: 'ERR_FS_CP_EEXIST', syscall: 'cp', path: '/data/c.txt' })
    await expect(fs.promises.cp('/data/d', '/data/g')).rejects.toMatchObject({
      code: 'ERR_FS_EISDIR',
      message:
        'Path is a directory: cp returned EISDIR (/data/d is a directory (not copied)) /data/d',
    })
    await expect(
      fs.promises.cp('/data/d', '/data/d/sub/x', { recursive: true }),
    ).rejects.toMatchObject({ code: 'ERR_FS_CP_EINVAL', path: '/data/d/sub/x' })
    await expect(fs.promises.cp('/data/c.txt', '/data/c.txt')).rejects.toMatchObject({
      code: 'ERR_FS_CP_EINVAL',
    })
    await expect(fs.promises.cp('/data/nope', '/data/x')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await ws.close()
  })

  it('cp copies across the mount edge, either way', async () => {
    const [ws, fs] = await world()
    const tree = join(scratch, 'tree')
    await fs.promises.mkdir(join(tree, 'in'), { recursive: true })
    writeFileSync(join(tree, 'in', 'x.txt'), 'x')
    await fs.promises.cp(tree, '/data/h', { recursive: true })
    expect(await fs.promises.readFile('/data/h/in/x.txt', 'utf-8')).toBe('x')
    await fs.promises.cp('/data/d', join(scratch, 'out'), { recursive: true })
    expect(readFileSync(join(scratch, 'out', 'sub', 'b.txt'), 'utf-8')).toBe('b')
    await ws.close()
  })
})

describe('patchNodeFs — access', () => {
  // W_OK answers what the write itself meets, for the session the files run
  // as (here the default one, bound by no one): a cap to read is refused, a
  // writable show entry below it is not, and a link answers for where it
  // leads.
  it("answers write from the session's mode", async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/f.txt', 'f')
    await ws.vfs.mkdir('/data/out')
    await ws.vfs.write('/data/out/g.txt', 'g')
    await ws.vfs.symlink('/data/link', '/data/out/g.txt')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs
    const { R_OK, W_OK } = fs.constants
    await fs.promises.access('/data/f.txt', W_OK)
    await ws.setSessionProfile(
      ws.defaultSessionId,
      parseSessionProfile({ mounts: { '/data': 'read' }, paths: { show: { '/data/out': 'rw' } } }),
    )
    await expect(fs.promises.access('/data/f.txt', W_OK)).rejects.toMatchObject({ code: 'EACCES' })
    await fs.promises.access('/data/f.txt', R_OK)
    await fs.promises.access('/data/out/g.txt', W_OK)
    await fs.promises.access('/data/link', W_OK)
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
      'an exclusive copy onto a dangling link',
      'EEXIST',
      (fs: Fs) => fs.promises.copyFile('/data/f.txt', '/data/dangling', fs.constants.COPYFILE_EXCL),
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
    ['a truncate of a missing file', 'ENOENT', (fs: Fs) => fs.promises.truncate('/data/nope')],
    [
      'an rm of a mount root spelled with a dot',
      'EBUSY',
      (fs: Fs) => fs.promises.rm('/data/.', { recursive: true }),
    ],
    [
      'an rmdir of a mount root spelled with a dot',
      'EBUSY',
      (fs: Fs) => fs.promises.rmdir('/data/.'),
    ],
    [
      'a sync spelling',
      'ENOTSUP',
      (fs: Fs) => Promise.resolve().then(() => fs.statSync('/data/f.txt')),
    ],
  ] as const)('refuses %s with %s', async (_label, code, call) => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/f.txt', 'f')
    await ws.vfs.mkdir('/data/d')
    await ws.vfs.symlink('/data/dangling', '/data/nowhere')
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

  it('counts a name another writer removed mid-rm as gone', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.mkdir('/data/d')
    await ws.vfs.write('/data/d/a.txt', 'a')
    await ws.vfs.write('/data/d/b.txt', 'b')
    const facade = ws.vfs as unknown as {
      dispatch: (name: string, path: string, ...rest: unknown[]) => Promise<unknown>
    }
    const dispatch = facade.dispatch.bind(ws.vfs)
    facade.dispatch = async (name, path, ...rest) => {
      if (name === 'unlink' && path === '/data/d/a.txt') await dispatch(name, path, ...rest)
      return dispatch(name, path, ...rest)
    }
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await fs.promises.rm('/data/d', { recursive: true })
    expect(await ws.vfs.exists('/data/d')).toBe(false)
    await ws.close()
  })

  it('leaves a directory another writer swapped for a link mid-rm', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    for (const dir of ['/data/t', '/data/t/child', '/data/outside']) await ws.vfs.mkdir(dir)
    await ws.vfs.write('/data/t/child/f.txt', 't')
    await ws.vfs.write('/data/outside/f.txt', 'o')
    const facade = ws.vfs as unknown as {
      dispatch: (name: string, path: string, ...rest: unknown[]) => Promise<unknown>
    }
    const dispatch = facade.dispatch.bind(ws.vfs)
    facade.dispatch = async (name, path, ...rest) => {
      const answer = await dispatch(name, path, ...rest)
      if (name === 'readdir' && path === '/data/t/child') {
        await ws.vfs.rename('/data/t/child', '/data/moved')
        await ws.vfs.symlink('/data/t/child', '/data/outside')
      }
      return answer
    }
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await expect(fs.promises.rm('/data/t', { recursive: true })).rejects.toMatchObject({
      code: 'ELOOP',
      path: '/data/t/child',
    })
    expect(await fs.promises.readFile('/data/outside/f.txt', 'utf-8')).toBe('o')
    expect(await fs.promises.readFile('/data/moved/f.txt', 'utf-8')).toBe('t')
    await ws.close()
  })

  it('removes a tree reached through a link above it', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.mkdir('/data/t')
    await ws.vfs.mkdir('/data/t/sub')
    await ws.vfs.write('/data/t/sub/f.txt', 'f')
    await ws.vfs.symlink('/data/up', '/data')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    await fs.promises.rm('/data/up/t', { recursive: true })
    expect(await fs.promises.readdir('/data')).toEqual(['up'])
    await ws.close()
  })

  it('answers EIO for a failure that names no condition', async () => {
    class Upstream extends RAMVFS {
      override read(): Promise<Uint8Array> {
        return Promise.reject(new Error('upstream 502 Bad Gateway'))
      }
    }
    const ws = new Workspace({ '/data': new Upstream() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/data/f.txt', 'f')
    restore = patchNodeFs(ws)
    const fs = requireCjs('fs') as Fs

    const err: unknown = await fs.promises.readFile('/data/f.txt').catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'EIO' })
    expect(((err as Error).cause as Error).message).toBe('upstream 502 Bad Gateway')
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
