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

import { SPECS } from '../../../commands/spec/index.ts'
import { PathSpec } from '../../../types.ts'
import { parseFlags } from './flags.ts'

function path(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: '', resolved: true })
}

describe('parseFlags', () => {
  it('separates by type when there is no spec', () => {
    const p = path('/data/a.txt')
    const [paths, texts, flags] = parseFlags([p, 'hello'], null, 'unknown', '/')
    expect(paths).toEqual([p])
    expect(texts).toEqual(['hello'])
    expect(flags).toEqual({})
  })

  it('keeps the classified PathSpec over synthesis', () => {
    const p = path('/data/a.txt')
    const [paths] = parseFlags([p], SPECS.cat ?? null, 'cat', '/')
    expect(paths[0]).toBe(p)
  })

  it('synthesized paths leave the backend key to the mount', () => {
    // A spec-classified PATH operand the classifier left as text; the
    // mount stamps resourcePath at execute time (sentinel-proven in
    // both languages).
    const [paths] = parseFlags(['b.txt'], SPECS.cat ?? null, 'cat', '/data')
    expect(paths.length).toBe(1)
    expect(paths[0]?.resourcePath).toBe('')
  })
})
