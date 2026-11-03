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

import { PathSpec } from '../../../../types.ts'
import { describe, expect, it } from 'vitest'
import { EmptyPathspecError, OutsideRepositoryError, UnsupportedPathspecError } from './errors.ts'
import { pathspecPatterns, pathspecSelects, patternRoots, repoRelative } from './pathspec.ts'
import type { RepoLocation } from './types.ts'

const LOCATION: RepoLocation = {
  gitdir: PathSpec.fromStrPath('/repo/.git'),
  commondir: PathSpec.fromStrPath('/repo/.git'),
  worktree: PathSpec.fromStrPath('/repo'),
  mountRoot: PathSpec.fromStrPath('/repo/'),
}

it.each([
  ['docs/a.md', [''], false, true],
  ['docs/a.md', ['docs'], false, true],
  ['docs/a.md', ['doc'], false, false],
  ['docs/a.md', ['docs/a.md'], false, true],
  ['docs/sub/a.md', ['*.md'], false, true],
  ['docs/a.md', ['docs/*.txt', '*.md'], false, true],
  ['a.txt', ['docs'], false, false],
])('names %s by path, directory or glob in %j', (path, patterns, directory, expected) => {
  expect(pathspecSelects(path, patterns, directory)).toBe(expected)
})

it.each([
  [':/', ''],
  [':/a.txt', 'a.txt'],
  [':/docs/notes.md', 'docs/notes.md'],
  [':/:a.txt', 'a.txt'],
])('reads top magic %j from the root', (operand, relative) => {
  expect(repoRelative(LOCATION, '/repo/docs', operand)).toBe(relative)
})

it('keeps a colon in the path without magic', () => {
  expect(repoRelative(LOCATION, '/repo', ':/a.txt', false)).toBe(':/a.txt')
})

it('reads top magic as a pattern from the root', () => {
  expect(pathspecPatterns(LOCATION, '/repo/docs', [':/', ':/docs/', ':/*.md'])).toEqual([
    '',
    'docs/',
    '*.md',
  ])
})

it.each([
  ['', EmptyPathspecError],
  [':(top)a.txt', UnsupportedPathspecError],
  [':!a.txt', UnsupportedPathspecError],
  [':/!a.txt', UnsupportedPathspecError],
  [':/^a.txt', UnsupportedPathspecError],
  ['/elsewhere/a.txt', OutsideRepositoryError],
])('refuses %j', (operand, error) => {
  expect(() => pathspecPatterns(LOCATION, '/repo', [operand])).toThrow(error)
})

// Twin of test_pattern_roots_are_the_literal_paths_a_walk_must_reach.
describe('patternRoots', () => {
  it.each([
    [
      ['a.txt', 'docs/'],
      ['a.txt', 'docs'],
    ],
    [
      ['src/*.py', 'lib/x?/y'],
      ['src', 'lib'],
    ],
    [['src/[ab].c'], ['src']],
    [['*.c'], null],
    [['a.txt', ''], null],
    [[], null],
  ] as [string[], string[] | null][])('%j reaches %j', (patterns, roots) => {
    expect(patternRoots(patterns)).toEqual(roots)
  })
})
