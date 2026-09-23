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
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { DiskVFS } from './vfs/disk/disk.ts'
import { patchNodeFs } from './fs_monkey.ts'
import { Workspace } from './workspace.ts'

type Fs = typeof fs

const requireCjs = createRequire(import.meta.url)

let scratch: string
let restore: (() => void) | null = null

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mirage-fsmonkey-'))
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
