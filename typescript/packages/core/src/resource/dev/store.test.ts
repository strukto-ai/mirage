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
import { DevFiles, DevStore } from './store.ts'

describe('DevFiles', () => {
  it('reports has() true only for null/zero (with or without leading slash)', () => {
    const f = new DevFiles()
    expect(f.has('/null')).toBe(true)
    expect(f.has('null')).toBe(true)
    expect(f.has('/zero')).toBe(true)
    expect(f.has('zero')).toBe(true)
    expect(f.has('/other')).toBe(false)
  })

  it('returns empty bytes for /null', () => {
    const f = new DevFiles()
    const v = f.get('/null')
    expect(v).toBeInstanceOf(Uint8Array)
    expect(v?.byteLength).toBe(0)
  })

  it('returns 1 MiB of zeros for /zero', () => {
    const f = new DevFiles()
    const v = f.get('/zero')
    expect(v).toBeInstanceOf(Uint8Array)
    expect(v?.byteLength).toBe(1 << 20)
    expect(v?.every((b) => b === 0)).toBe(true)
  })

  it('returns undefined for unknown keys', () => {
    const f = new DevFiles()
    expect(f.get('/missing')).toBeUndefined()
  })

  it('discards writes to an active synthetic device', () => {
    const f = new DevFiles()
    f.set('/null', new TextEncoder().encode('overwrite'))
    expect(f.get('/null')?.byteLength).toBe(0)
    expect(f.get('/zero')?.byteLength).toBe(1 << 20)
  })

  it('delete tombstones a synthetic device', () => {
    const f = new DevFiles()
    expect(f.delete('/null')).toBe(true)
    expect(f.has('/null')).toBe(false)
    expect(f.get('/null')).toBeUndefined()
    expect([...f.keys()]).toEqual(['/zero'])
    expect(f.size).toBe(1)
    expect(f.delete('/null')).toBe(false)
  })

  it('set after delete stores real bytes (rm-then-redirect recreation)', () => {
    const f = new DevFiles()
    expect(f.delete('/null')).toBe(true)
    f.set('/null', new TextEncoder().encode('recreated'))
    expect(f.has('/null')).toBe(true)
    expect(new TextDecoder().decode(f.get('/null'))).toBe('recreated')
    expect([...f.keys()]).toEqual(['/zero', '/null'])
    expect(f.size).toBe(2)
  })

  it('delete of a recreated real file removes it again', () => {
    const f = new DevFiles()
    f.delete('/null')
    f.set('/null', new TextEncoder().encode('recreated'))
    expect(f.delete('/null')).toBe(true)
    expect(f.has('/null')).toBe(false)
    expect([...f.keys()]).toEqual(['/zero'])
  })

  it('stores non-device names for real', () => {
    const f = new DevFiles()
    f.set('/custom', new TextEncoder().encode('bytes'))
    expect(f.has('/custom')).toBe(true)
    expect(new TextDecoder().decode(f.get('/custom'))).toBe('bytes')
    expect([...f.keys()]).toEqual(['/null', '/zero', '/custom'])
    expect(f.delete('/custom')).toBe(true)
    expect(f.has('/custom')).toBe(false)
  })

  it('clear stays a no-op', () => {
    const f = new DevFiles()
    f.clear()
    expect(f.has('/null')).toBe(true)
    expect(f.has('/zero')).toBe(true)
  })

  it('iterates as [/null, /zero]', () => {
    const f = new DevFiles()
    expect([...f.keys()]).toEqual(['/null', '/zero'])
    expect(f.size).toBe(2)
  })
})

describe('DevStore', () => {
  it('starts with the synthetic files and root dir', () => {
    const s = new DevStore()
    expect(s.files.size).toBe(2)
    expect(s.dirs.has('/')).toBe(true)
    expect(s.modified.size).toBe(0)
  })
})
