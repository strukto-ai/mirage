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

import { expect, it } from 'vitest'
import { mapped, parseRefspec, safeRefName, wholeRefName } from './refs.ts'

it.each([
  ['main', { src: 'main', dst: null, force: false }],
  [
    '+refs/heads/*:refs/remotes/origin/*',
    { src: 'refs/heads/*', dst: 'refs/remotes/origin/*', force: true },
  ],
  ['topic:copy', { src: 'topic', dst: 'copy', force: false }],
  ['main:', { src: 'main', dst: null, force: false }],
])('splits the refspec %s', (text, expected) => {
  expect(parseRefspec(text)).toEqual(expected)
})

it.each([
  ['+refs/heads/*:refs/remotes/origin/*', 'refs/heads/feat/x', 'refs/remotes/origin/feat/x'],
  ['+refs/heads/*:refs/remotes/origin/*', 'refs/tags/v1', null],
  ['refs/heads/main:refs/heads/copy', 'refs/heads/main', 'refs/heads/copy'],
  ['refs/heads/main', 'refs/heads/main', ''],
])('maps %s over %s', (spec, name, expected) => {
  expect(mapped(parseRefspec(spec), name)).toBe(expected)
})

it.each([
  ['HEAD', true],
  ['ORIG_HEAD', true],
  ['refs/heads/main', true],
  ['refs/heads/a..b', true],
  ['lower', false],
  ['A1', false],
  ['refs/', false],
  ['refs/heads//x', false],
  ['refs/heads/./x', false],
  ['refs/heads/../x', false],
])('safeRefName follows refname_is_safe: %s', (name, safe) => {
  expect(safeRefName(name)).toBe(safe)
})

it('takes no bare @ as a whole ref name', () => {
  expect(wholeRefName('@')).toBe(false)
  expect(wholeRefName('HEAD')).toBe(true)
})
