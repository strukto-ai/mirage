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
import { RAMAccessor } from '../../accessor/ram.ts'
import { RAMStore } from '../../resource/ram/store.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { rename } from './rename.ts'
import { setAttrs } from './set_attrs.ts'
import { stat } from './stat.ts'
import { unlink } from './unlink.ts'

function mkPath(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
    resolved: true,
  })
}

function mkAccessor(): RAMAccessor {
  const store = new RAMStore()
  store.files.set('/f.txt', new TextEncoder().encode('hello'))
  store.dirs.add('/sub')
  return new RAMAccessor(store)
}

describe('core/ram setAttrs', () => {
  it('fields are reported by stat', async () => {
    const acc = mkAccessor()
    await setAttrs(acc, mkPath('/f.txt'), {
      mode: 0o601,
      uid: 500,
      gid: 'dev',
      atime: '2026-01-02T00:00:00+00:00',
    })
    const s = await stat(acc, mkPath('/f.txt'))
    expect(s.mode).toBe(0o601)
    expect(s.uid).toBe(500)
    expect(s.gid).toBe('dev')
    expect(s.atime).toBe('2026-01-02T00:00:00+00:00')
  })

  it('partial updates keep other fields', async () => {
    const acc = mkAccessor()
    await setAttrs(acc, mkPath('/f.txt'), { mode: 0o600 })
    await setAttrs(acc, mkPath('/f.txt'), { uid: 'alice' })
    const s = await stat(acc, mkPath('/f.txt'))
    expect(s.mode).toBe(0o600)
    expect(s.uid).toBe('alice')
    expect(s.gid).toBeNull()
  })

  it('mtime updates the modified table', async () => {
    const acc = mkAccessor()
    await setAttrs(acc, mkPath('/f.txt'), { mtime: '2026-03-04T12:00:00+00:00' })
    expect(acc.store.modified.get('/f.txt')).toBe('2026-03-04T12:00:00+00:00')
  })

  it('works on directories', async () => {
    const acc = mkAccessor()
    await setAttrs(acc, mkPath('/sub'), { mode: 0o700 })
    const s = await stat(acc, mkPath('/sub'))
    expect(s.mode).toBe(0o700)
  })

  it('throws for a missing path', () => {
    const acc = mkAccessor()
    expect(() => setAttrs(acc, mkPath('/nope.txt'), { mode: 0o644 })).toThrow()
  })

  it('unlink drops attrs so a recreated file starts clean', async () => {
    const acc = mkAccessor()
    await setAttrs(acc, mkPath('/f.txt'), { mode: 0o600 })
    await unlink(acc, mkPath('/f.txt'))
    acc.store.files.set('/f.txt', new TextEncoder().encode('recreated'))
    const s = await stat(acc, mkPath('/f.txt'))
    expect(s.mode).toBeNull()
  })

  it('rename moves attrs with the file', async () => {
    const acc = mkAccessor()
    await setAttrs(acc, mkPath('/f.txt'), { mode: 0o600, uid: 500 })
    await rename(acc, mkPath('/f.txt'), mkPath('/g.txt'))
    const s = await stat(acc, mkPath('/g.txt'))
    expect(s.mode).toBe(0o600)
    expect(s.uid).toBe(500)
    expect(acc.store.attrs.has('/f.txt')).toBe(false)
  })
})
