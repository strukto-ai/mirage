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
import { PathSpec } from '../../types.ts'
import { RAMVFS } from './ram.ts'

describe('RAM VFS: presign + fingerprint', () => {
  it('presign is not implemented on RAM (no method on the interface)', () => {
    const r = new RAMVFS() as unknown as { presign?: unknown }
    expect(typeof r.presign).toBe('undefined')
  })

  it('fingerprint is not implemented on RAM (no method on the interface)', () => {
    const r = new RAMVFS() as unknown as { fingerprint?: unknown }
    expect(typeof r.fingerprint).toBe('undefined')
  })

  it('RAM VFS exposes read/write/stat ops', () => {
    const r = new RAMVFS()
    const ops = r.ops()
    const names = new Set(ops.map((o) => o.name))
    expect(names.has('read_bytes') || names.has('read')).toBe(true)
    expect(names.has('write')).toBe(true)
    expect(names.has('stat')).toBe(true)
  })

  it('RAM VFS ops list is non-empty', () => {
    const r = new RAMVFS()
    expect(r.ops().length).toBeGreaterThan(0)
  })

  it('glob is callable on RAM store when files exist', async () => {
    const r = new RAMVFS()
    r.store.files.set('/a.txt', new Uint8Array([1]))
    const result = await (r as unknown as { glob(p: PathSpec[]): Promise<PathSpec[]> }).glob([
      PathSpec.fromStrPath('/a.txt'),
    ])
    expect(result.length).toBe(1)
  })
})
