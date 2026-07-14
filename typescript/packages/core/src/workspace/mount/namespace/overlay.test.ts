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
import { FileStat } from '../../../types.ts'
import { mergeOverlayStat } from './overlay.ts'

const base = new FileStat({ name: 'f.txt', size: 3, modified: '2026-01-01T00:00:00Z' })

describe('mergeOverlayStat', () => {
  it('returns the stat unchanged for null meta', () => {
    expect(mergeOverlayStat(null, base)).toBe(base)
  })

  it('returns the stat unchanged for an empty meta', () => {
    expect(mergeOverlayStat({}, base)).toBe(base)
  })

  it('lets overlay fields win while keeping the rest', () => {
    const merged = mergeOverlayStat({ mode: 0o640, uid: 7, gid: 8 }, base)
    expect(merged.mode).toBe(0o640)
    expect(merged.uid).toBe(7)
    expect(merged.gid).toBe(8)
    expect(merged.size).toBe(3)
    expect(merged.modified).toBe('2026-01-01T00:00:00Z')
  })

  it('overlays modified from mtime', () => {
    const merged = mergeOverlayStat({ mtime: 1767312000 }, base)
    expect(merged.modified).toBe('2026-01-02T00:00:00Z')
  })

  it('does not touch modified for a link entry', () => {
    const merged = mergeOverlayStat({ target: '/other', mtime: 1767312000 }, base)
    expect(merged.modified).toBe('2026-01-01T00:00:00Z')
  })
})
