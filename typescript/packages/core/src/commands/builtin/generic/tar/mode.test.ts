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
import { isCreateMode } from './mode.ts'

it.each([
  [['-czf', 'out.tgz', 'dir'], true],
  [['--create', '-f', 'out.tar', 'dir'], true],
  [['-xzf', 'a.tgz', './m/x.json'], false],
  [['-tzf', 'a.tgz'], false],
  [['cf', 'a.tar', 'd'], true],
  [['fc', 'a.tar', 'd'], true],
  [['-xf', 'a.tar', 'crate'], false],
  [['--exclude', 'c', '-xf', 'a.tar'], false],
  // GNU reads everything after -- as an operand (`tar: -C: Not found in
  // archive`).
  [['-xf', 'a.tar', '--', '-c'], false],
  [['-xf', 'a.tar', '--', '--create'], false],
  [['-cf', 'a.tar', '--', '-c'], true],
  [['--crea', '-f', 'a.tar', 'd'], true],
  [['--cr=x'], true],
  // Ambiguous in tar's own table, so no mode at all.
  [['--c', '-f', 'a.tar'], false],
  [['--get', '-f', 'a.tar'], false],
])('isCreateMode(%j) is %s', (argv, create) => {
  expect(isCreateMode(argv)).toBe(create)
})
