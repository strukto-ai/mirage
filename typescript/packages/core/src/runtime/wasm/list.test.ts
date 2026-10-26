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
import { FT_DIR, FT_REG } from './constants.ts'
import { packDirent } from './list.ts'

const ENC = new TextEncoder()

it('is the preview1 dirent layout plus the name', () => {
  expect(packDirent(0, ENC.encode('abc'), FT_DIR).byteLength).toBe(24 + 3)
})

it('carries the cookie, the name and the type', () => {
  const record = packDirent(4, ENC.encode('f.txt'), FT_REG)
  const view = new DataView(record.buffer)
  expect([
    view.getBigUint64(0, true),
    view.getBigUint64(8, true),
    view.getUint32(16, true),
    view.getUint8(20),
  ]).toEqual([5n, 5n, 5, FT_REG])
  expect(new TextDecoder().decode(record.subarray(24))).toBe('f.txt')
})
