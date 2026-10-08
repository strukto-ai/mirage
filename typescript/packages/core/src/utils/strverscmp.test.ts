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
import { strverscmp } from './strverscmp.ts'

it.each([
  ['v1.0', 'v1.0', 0],
  ['a', 'b', -1],
  ['v1.9', 'v1.10', -1],
  ['x10', 'x9z', 1],
  ['alpha1', 'alpha001', 1],
  ['part1_f012', 'part1_f01', 1],
  ['foo.009', 'foo.0', -1],
  ['a0b', 'a00b', 1],
  ['v2.0-rc1', 'v2.0', 1],
  ['ISO8859-1//', 'ISO88591//', -1],
  ['4.010', '4.9', -1],
  ['4..9', '4.9', -1],
])('orders %s and %s as glibc does', (a, b, sign) => {
  expect(Math.sign(strverscmp(a, b))).toBe(sign)
})
