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
import type { Resource } from '../../../resource/base.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { MountRegistry } from '../../mount/registry.ts'
import { relativeSpec } from './relative.ts'

class StubResource implements Resource {
  readonly kind = 'stub'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

function setup(): MountRegistry {
  return new MountRegistry({ '/ram': new StubResource() }, MountMode.WRITE)
}

describe('relativeSpec', () => {
  it('resolves a plain word against cwd and keeps the raw form', () => {
    const r = relativeSpec('sub/a.txt', setup(), '/ram')
    if (!(r instanceof PathSpec)) throw new Error('expected PathSpec')
    expect(r.virtual).toBe('/ram/sub/a.txt')
    expect(r.rawPath).toBe('sub/a.txt')
    expect(r.resolved).toBe(true)
    expect(r.pattern).toBeNull()
  })

  it('turns glob chars in the word into a pattern spec', () => {
    const r = relativeSpec('sub/*.txt', setup(), '/ram')
    if (!(r instanceof PathSpec)) throw new Error('expected PathSpec')
    expect(r.directory).toBe('/ram/sub/')
    expect(r.pattern).toBe('*.txt')
    expect(r.resolved).toBe(false)
    expect(r.rawPath).toBe('sub/*.txt')
  })

  it('normalizes .. against cwd', () => {
    const r = relativeSpec('../x.txt', setup(), '/ram/sub')
    if (!(r instanceof PathSpec)) throw new Error('expected PathSpec')
    expect(r.virtual).toBe('/ram/x.txt')
    expect(r.rawPath).toBe('../x.txt')
  })

  it('keeps unmounted words as plain text', () => {
    expect(relativeSpec('a.txt', setup(), '/elsewhere')).toBe('a.txt')
  })

  it('rawPath round-trips the typed spelling', () => {
    const r = relativeSpec('./sub/a.txt', setup(), '/ram')
    if (!(r instanceof PathSpec)) throw new Error('expected PathSpec')
    expect(r.rawPath).toBe('./sub/a.txt')
    expect(r.virtual).toBe('/ram/sub/a.txt')
  })
})
