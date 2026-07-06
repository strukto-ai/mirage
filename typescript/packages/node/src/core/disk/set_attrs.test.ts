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

import { readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiskAccessor } from '../../accessor/disk.ts'
import { spec, tmpRoot } from '../../test-utils.ts'
import { rename } from './rename.ts'
import { setAttrs } from './set_attrs.ts'
import { stat } from './stat.ts'
import { unlink } from './unlink.ts'

let root: string
let accessor: DiskAccessor
let cleanup: () => void

beforeEach(async () => {
  ;({ root, accessor, cleanup } = tmpRoot('mirage-core-disk-setattr-'))
  await writeFile(join(root, 'f.txt'), 'hello')
})
afterEach(() => {
  cleanup()
})

describe('core/disk setAttrs', () => {
  it('mode hits the real inode and the sidecar', async () => {
    await setAttrs(accessor, spec('/f.txt'), { mode: 0o601 })
    expect(statSync(join(root, 'f.txt')).mode & 0o777).toBe(0o601)
    const s = await stat(accessor, spec('/f.txt'))
    expect(s.mode).toBe(0o601)
  })

  it('mode 000 keeps owner access on the inode', async () => {
    await setAttrs(accessor, spec('/f.txt'), { mode: 0 })
    expect(statSync(join(root, 'f.txt')).mode & 0o777).toBe(0o600)
    const s = await stat(accessor, spec('/f.txt'))
    expect(s.mode).toBe(0)
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('hello')
  })

  it('dir mode keeps owner traversal on the inode', async () => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'x.txt'), 'x')
    await setAttrs(accessor, spec('/sub'), { mode: 0o050 })
    expect(statSync(join(root, 'sub')).mode & 0o777).toBe(0o750)
    expect(readFileSync(join(root, 'sub', 'x.txt'), 'utf8')).toBe('x')
    const s = await stat(accessor, spec('/sub'))
    expect(s.mode).toBe(0o050)
  })

  it('ownership is sidecar-only', async () => {
    const before = statSync(join(root, 'f.txt'))
    await setAttrs(accessor, spec('/f.txt'), { uid: 500, gid: 'dev' })
    const after = statSync(join(root, 'f.txt'))
    expect(after.uid).toBe(before.uid)
    expect(after.gid).toBe(before.gid)
    const s = await stat(accessor, spec('/f.txt'))
    expect(s.uid).toBe(500)
    expect(s.gid).toBe('dev')
  })

  it('mtime hits the real inode', async () => {
    await setAttrs(accessor, spec('/f.txt'), { mtime: '2026-03-04T12:00:00+00:00' })
    const s = await stat(accessor, spec('/f.txt'))
    expect(s.modified).toContain('2026-03-04T12:00:00')
  })

  it('atime is recorded in the sidecar', async () => {
    await setAttrs(accessor, spec('/f.txt'), { atime: '2026-03-04T12:00:00+00:00' })
    const s = await stat(accessor, spec('/f.txt'))
    expect(s.atime).toBe('2026-03-04T12:00:00+00:00')
  })

  it('throws for a missing path', async () => {
    await expect(setAttrs(accessor, spec('/nope.txt'), { mode: 0o644 })).rejects.toThrow()
  })

  it('unlink drops the sidecar entry', async () => {
    await setAttrs(accessor, spec('/f.txt'), { uid: 500 })
    await unlink(accessor, spec('/f.txt'))
    await writeFile(join(root, 'f.txt'), 'recreated')
    const s = await stat(accessor, spec('/f.txt'))
    expect(s.uid).toBeNull()
  })

  it('rename moves the sidecar entry', async () => {
    await setAttrs(accessor, spec('/f.txt'), { uid: 500, gid: 'dev' })
    await rename(accessor, spec('/f.txt'), spec('/g.txt'))
    const s = await stat(accessor, spec('/g.txt'))
    expect(s.uid).toBe(500)
    expect(s.gid).toBe('dev')
    expect(accessor.attrs.has('/f.txt')).toBe(false)
  })
})
