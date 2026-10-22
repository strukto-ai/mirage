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

import { WILDCARD } from '../constants.ts'
import { patternMatches, patternReaches, splitPattern } from './pattern.ts'

describe('patterns', () => {
  it('splitPattern drops trailing wildcards only', () => {
    expect(splitPattern('git push')).toEqual(['git', 'push'])
    expect(splitPattern('git *')).toEqual(['git'])
    expect(splitPattern('git * *')).toEqual(['git'])
    expect(splitPattern('git * --hard')).toEqual(['git', WILDCARD, '--hard'])
    expect(splitPattern('  rm  ')).toEqual(['rm'])
    expect(splitPattern('*')).toEqual([])
  })

  it('patternMatches is a token prefix', () => {
    expect(patternMatches('rm', ['rm', '-rf', '/x'])).toBe(true)
    expect(patternMatches('rm', ['rm'])).toBe(true)
    expect(patternMatches('rm', ['rmdir'])).toBe(false)
    expect(patternMatches('git push', ['git', 'push', 'origin', 'main'])).toBe(true)
    expect(patternMatches('git push', ['git', 'pull'])).toBe(false)
    expect(patternMatches('git push', ['git'])).toBe(false)
    expect(patternMatches('git reset --hard', ['git', 'reset', '--hard', 'HEAD'])).toBe(true)
    expect(patternMatches('git reset --hard', ['git', 'reset', 'HEAD', '--hard'])).toBe(false)
    // A wildcard token is any one token; trailing it is redundant.
    expect(patternMatches('git * --hard', ['git', 'reset', '--hard'])).toBe(true)
    expect(patternMatches('git * --hard', ['git', 'reset', '--soft'])).toBe(false)
    expect(patternMatches('git *', ['git'])).toBe(true)
    expect(patternMatches('*', ['anything', 'at', 'all'])).toBe(true)
  })

  it('patternReaches a command a line of it starts', () => {
    expect(patternReaches('git log', ['git'])).toBe(true)
    expect(patternReaches('git log', ['log'])).toBe(false)
    expect(patternReaches('*', ['rm'])).toBe(true)
  })

  it('patternReaches reads only the words the two share', () => {
    // The pattern runs past the path: one line of that group is
    // allowed, so the group is reachable.
    expect(patternReaches('linear issue list', ['linear', 'issue'])).toBe(true)
    expect(patternReaches('linear issue list', ['linear'])).toBe(true)
    // The path runs past the pattern: already covered.
    expect(patternReaches('linear issue', ['linear', 'issue', 'list'])).toBe(true)
    // A word they share disagrees, at any depth.
    expect(patternReaches('linear issue list', ['linear', 'team'])).toBe(false)
    expect(patternReaches('linear issue list', ['linear', 'issue', 'create'])).toBe(false)
    expect(patternReaches('linear issue', ['gws', 'issue'])).toBe(false)
    // A wildcard is any one word, and a trailing one is dropped, so
    // `linear issue *` reaches every leaf of that group.
    expect(patternReaches('linear * list', ['linear', 'team', 'list'])).toBe(true)
    expect(patternReaches('linear issue *', ['linear', 'issue', 'create'])).toBe(true)
    expect(patternReaches('*', ['anything', 'at', 'all'])).toBe(true)
    // An empty path asks nothing, so nothing can refuse it.
    expect(patternReaches('linear issue', [])).toBe(true)
  })
})
