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
import { classifyWord, unescapePath } from './heuristic.ts'

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

describe('unescapePath', () => {
  it('strips backslash escapes from paths', () => {
    expect(unescapePath("Zecheng\\'s\\ Server")).toBe("Zecheng's Server")
  })

  it('leaves unescaped strings untouched', () => {
    expect(unescapePath('/a/b/c')).toBe('/a/b/c')
  })
})

describe('classifyWord — absolute paths', () => {
  it('returns PathSpec for a file inside a mount', () => {
    const reg = setup()
    const r = classifyWord('/ram/x.txt', reg, '/')
    expect(r).toBeInstanceOf(PathSpec)
    if (r instanceof PathSpec) {
      expect(r.virtual).toBe('/ram/x.txt')
      expect(r.resolved).toBe(true)
    }
  })

  it('returns PathSpec with pattern for a glob', () => {
    const reg = setup()
    const r = classifyWord('/ram/*.txt', reg, '/')
    if (!(r instanceof PathSpec)) throw new Error('expected PathSpec')
    expect(r.pattern).toBe('*.txt')
    expect(r.resolved).toBe(false)
  })

  it('returns the raw string when path does not match any mount', () => {
    const reg = setup()
    expect(classifyWord('/elsewhere/x', reg, '/')).toBe('/elsewhere/x')
  })

  it('recognizes a trailing-slash path as a directory', () => {
    const reg = setup()
    const r = classifyWord('/ram/sub/', reg, '/')
    if (!(r instanceof PathSpec)) throw new Error('expected PathSpec')
    expect(r.directory).toBe('/ram/sub/')
    expect(r.resolved).toBe(false)
  })
})

describe('classifyWord — relative paths', () => {
  it('leaves bare filenames as text', () => {
    const reg = setup()
    expect(classifyWord('file.txt', reg, '/ram')).toBe('file.txt')
  })

  it('classifies relative path with / as PathSpec resolved against cwd', () => {
    const reg = setup()
    const r = classifyWord('sub/file.txt', reg, '/ram')
    if (!(r instanceof PathSpec)) throw new Error('expected PathSpec')
    expect(r.virtual).toBe('/ram/sub/file.txt')
  })

  it('leaves bare glob (like *) as text — could be a command arg', () => {
    const reg = setup()
    expect(classifyWord('*', reg, '/ram')).toBe('*')
  })
})
