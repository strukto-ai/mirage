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
import { stripSlash } from '../../utils/slash.ts'
import { detectScope } from './scope.ts'

function ps(p: string): PathSpec {
  return new PathSpec({ vfsPath: stripSlash(p), virtual: p, directory: p })
}

describe('gslides detectScope', () => {
  it('classifies the root', () => {
    expect(detectScope(ps('/')).kind).toBe('root')
  })

  it('classifies the corpus dirs', () => {
    for (const name of ['owned', 'shared']) {
      const match = detectScope(ps(`/${name}`))
      expect(match.kind).toBe('corpus')
      expect(match.slots).toEqual({ corpus: name })
    }
  })

  it('splits a file into label and id', () => {
    const match = detectScope(ps('/owned/2024-01-05_Notes__abc12.gslide.json'))
    expect(match.kind).toBe('file')
    expect(match.slots).toEqual({
      corpus: 'owned',
      name: '2024-01-05_Notes',
      file_id: 'abc12',
    })
  })

  it('matches a shared file too', () => {
    const match = detectScope(ps('/shared/Plan__xyz.gslide.json'))
    expect(match.kind).toBe('file')
    expect(match.slots.file_id).toBe('xyz')
  })

  it('answers invalid for unrecognized shapes', () => {
    expect(detectScope(ps('/bogus')).kind).toBe('invalid')
    expect(detectScope(ps('/bogus/File__id.gslide.json')).kind).toBe('invalid')
    expect(detectScope(ps('/owned/plain.gslide.json')).kind).toBe('invalid')
    expect(detectScope(ps('/owned/File__id.wrong.json')).kind).toBe('invalid')
    expect(detectScope(ps('/owned/File__id.gslide.json/deep')).kind).toBe('invalid')
  })
})
