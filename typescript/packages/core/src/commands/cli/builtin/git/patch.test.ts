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
import { wholeChars } from './patch.ts'

const ENC = new TextEncoder()
const join = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]))
const a = (n: number): Uint8Array => ENC.encode('A'.repeat(n))

// Pinned against git 2.47.3: a hunk header's function name loses the UTF-8
// sequence its cut leaves short, a lone lead byte included.
it.each<[Uint8Array, Uint8Array]>([
  [join(a(79), ENC.encode('가').subarray(0, 1)), a(79)],
  [join(a(78), ENC.encode('가').subarray(0, 2)), a(78)],
  [join(a(77), ENC.encode('가')), join(a(77), ENC.encode('가'))],
  [join(a(78), ENC.encode('😀').subarray(0, 2)), a(78)],
  [join(a(10), Uint8Array.of(0xe9)), a(10)],
  [ENC.encode('plain'), ENC.encode('plain')],
  [new Uint8Array(), new Uint8Array()],
])('drops a cut character', (data, kept) => {
  expect(wholeChars(data)).toEqual(kept)
})
