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
import { classifyBarePath } from './path.ts'

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

describe('classifyBarePath', () => {
  it('forces classification of a bare filename under cwd', () => {
    const reg = setup()
    const r = classifyBarePath('file.txt', reg, '/ram')
    if (!(r instanceof PathSpec)) throw new Error('expected PathSpec')
    expect(r.virtual).toBe('/ram/file.txt')
    expect(r.rawPath).toBe('file.txt')
  })

  it('bare glob becomes a pattern under cwd', () => {
    const reg = setup()
    const r = classifyBarePath('f?.txt', reg, '/ram')
    if (!(r instanceof PathSpec)) throw new Error('expected PathSpec')
    expect(r.pattern).toBe('f?.txt')
    expect(r.directory).toBe('/ram/')
  })

  it('absolute path delegates to the heuristic', () => {
    const reg = setup()
    const r = classifyBarePath('/ram/file.txt', reg, '/')
    if (!(r instanceof PathSpec)) throw new Error('expected PathSpec')
    expect(r.virtual).toBe('/ram/file.txt')
  })
})
