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
import { PathSpec } from '../../../../types.ts'
import { Files } from '../../../../workspace/files.ts'
import { BadRefNameUpdateError } from './errors.ts'
import {
  mapped,
  parseRefspec,
  safeRefName,
  validBranchName,
  wholeRefName,
  writeRef,
} from './refs.ts'

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
])('safeRefName follows git: %s', (name, safe) => {
  expect(safeRefName(name)).toBe(safe)
})

it('takes no bare @ as a whole ref name', () => {
  expect(wholeRefName('@')).toBe(false)
  expect(wholeRefName('HEAD')).toBe(true)
})

it('refuses to write a ref whose name leaves the ref tree', async () => {
  const files = new Files((op, path) => {
    throw new Error(`${op} ${path.virtual} reached the mount`)
  })
  const written = writeRef(
    files,
    PathSpec.fromStrPath('/repo/.git'),
    'refs/heads/../../config',
    'cdd6234342b147880f5d86c55dad6c1fbe222bfe',
  )
  await expect(written).rejects.toThrow(BadRefNameUpdateError)
  await expect(written).rejects.toThrow(
    "refusing to update ref with bad name 'refs/heads/../../config'",
  )
})

it.each([
  ['main', true],
  ['feature/HEAD', true],
  ['HEADS', true],
  ['x-', true],
  ['@', true],
  ['HEAD', false],
  ['-x', false],
  ['a..b', false],
])('validBranchName follows git branch rules: %s', (name, valid) => {
  expect(validBranchName(name)).toBe(valid)
})
