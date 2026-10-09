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

import { BadConfigValueError } from './errors.ts'
import { configSection, gitBool, maybeBool, splitMarked, withoutSection } from './util.ts'
import { walk } from '../../walk.ts'
import { GIT } from './index.ts'

describe('gitBool', () => {
  it.each([
    'true',
    'YES',
    'On',
    '1',
    '-1',
    '+1',
    '0x10',
    '010',
    '2k',
    '1g',
    ' 1',
    '-2097152k',
    '2147483647',
    '-2147483648',
  ])('reads %j as true', (value) => {
    expect(gitBool([value], 'core.bare', false)).toBe(true)
  })

  it.each(['false', 'No', 'OFF', '', '0', '-0'])('reads %j as false', (value) => {
    expect(gitBool([value], 'core.bare', true)).toBe(false)
  })

  // Pinned against git 2.54: strtoimax in base 0, one k, m or g, and a product
  // that has to fit an int.
  it.each([
    'maybe',
    ' true',
    '08',
    '0x',
    '1x',
    '1 ',
    '- 1',
    '2g',
    '2097152k',
    '2147483648',
    '-2147483649',
    '99999999999',
  ])('cannot read %j', (value) => {
    const read = (): boolean => gitBool([value], 'core.bare', false)
    expect(read).toThrow(BadConfigValueError)
    expect(read).toThrow(`bad boolean config value '${value}' for 'core.bare'`)
  })

  it('lets the last occurrence win', () => {
    expect(gitBool(['true', 'false'], 'core.bare', true)).toBe(false)
    expect(gitBool([], 'core.bare', true)).toBe(true)
  })

  it('parses every occurrence', () => {
    expect(() => gitBool(['maybe', 'true'], 'core.bare', false)).toThrow(BadConfigValueError)
  })
})

it('lands a later relative -C under the one before it', () => {
  const result = walk('git', GIT.spec, ['-C', '/repo', '-C', 'docs', 'status'], '/')
  expect(result.groupFlags['-C']).toMatchObject({ virtual: '/repo/docs' })
})

it.each([
  [
    ['A', 'B'],
    ['diff', 'A', 'B'],
    [['A', 'B'], []],
  ],
  [
    ['A', 'B', 'kind.txt'],
    ['diff', 'A', 'B', '--', 'kind.txt'],
    [['A', 'B'], ['kind.txt']],
  ],
  [['x'], ['diff', '--cached', '--', 'x'], [[], ['x']]],
  [
    ['A', '--'],
    ['show', 'A', '--', '--'],
    [['A'], ['--']],
  ],
])('splits %j at the marker in %j', (texts, argv, expected) => {
  expect(splitMarked(texts, argv)).toEqual(expected)
})

describe('configSection', () => {
  it('escapes its name and quotes a value holding a comment start', () => {
    expect(
      configSection('branch', 'q"x', [
        ['remote', 'origin'],
        ['merge', 'refs/heads/we#rd'],
        ['note', ' pad\tend '],
      ]),
    ).toBe(
      '[branch "q\\"x"]\n\tremote = origin\n\tmerge = "refs/heads/we#rd"\n\tnote = " pad\\tend "\n',
    )
  })
})

describe('withoutSection', () => {
  const text =
    '[core]\n\tbare = false\n[branch "topic"]\n\tremote = o\n[branch "main"]\n\tremote = o\n' +
    '[branch.topic]\n\tmerge = m\n  [branch   "topic"] remote = o\n\tmerge = m\n' +
    '[Branch "topic"]\n\tremote = o\n[branch.TOPIC]\n\tremote = o\n[branch "q\\"x"]\n\tremote = o\n'

  it('drops the blocks git matches by name', () => {
    expect(withoutSection(text, 'branch', 'topic')).toBe(
      '[core]\n\tbare = false\n[branch "main"]\n\tremote = o\n' +
        '[Branch "topic"]\n\tremote = o\n[branch.TOPIC]\n\tremote = o\n[branch "q\\"x"]\n\tremote = o\n',
    )
    expect(withoutSection(text, 'branch', 'q"x').endsWith('[branch.TOPIC]\n\tremote = o\n')).toBe(
      true,
    )
  })
})

describe('withoutSection over continued values', () => {
  const text =
    '[core]\n\tbare = false\n[branch "c1"]\n\tdescription = one \\\n' +
    '[two\n\tremote = origin\n[branch "keep"]\n\tremote = origin\n' +
    '[branch "c2"]\n\tdescription = "a\\\n  [b"\n\tremote = origin\n' +
    '[branch "c3"]\n\tnote = x \\\\\n[branch "keep2"]\n\tremote = o\n' +
    '# see \\\n[branch "c4"]\n\tremote = origin\n'

  it('follows a value continued onto a line that opens with a bracket', () => {
    expect(withoutSection(text, 'branch', 'c1')).toBe(
      '[core]\n\tbare = false\n[branch "keep"]\n\tremote = origin\n' +
        '[branch "c2"]\n\tdescription = "a\\\n  [b"\n\tremote = origin\n' +
        '[branch "c3"]\n\tnote = x \\\\\n[branch "keep2"]\n\tremote = o\n' +
        '# see \\\n[branch "c4"]\n\tremote = origin\n',
    )
    expect(withoutSection(text, 'branch', 'c2')).not.toContain('  [b"')
    expect(withoutSection(text, 'branch', 'c3').split('keep2').length).toBe(2)
    expect(withoutSection(text, 'branch', 'c4').endsWith('# see \\\n')).toBe(true)
  })
})

it.each([
  ['true', true],
  ['On', true],
  ['', false],
  ['no', false],
  ['2', true],
  ['0', false],
  ['1k', true],
  ['full', null],
])('maybeBool reads words and numbers: %s', (value, parsed) => {
  expect(maybeBool(value)).toBe(parsed)
})
