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
import { PathSpec } from '../../types.ts'
import { refusal } from './errors.ts'

const PATH = PathSpec.fromStrPath('/tmp/x')
const ENC = new TextEncoder()

describe('refusal', () => {
  it.each([
    ['cat: /tmp/x: No such file or directory\n', 'ENOENT'],
    ["mv: cannot stat 'a': Not a directory\n", 'ENOTDIR'],
    ["rm: cannot remove 'x': Permission denied\nmore\n", 'EACCES'],
    ['sh: 1: cannot create /tmp/x: Directory nonexistent\n', 'ENOENT'],
    ['something else\n', 'EIO'],
    ['', 'EIO'],
  ])('reads the first complaint of %j', (said, code) => {
    const err = refusal(PATH, ENC.encode(said))
    expect([err.code, err.virtualPath]).toEqual([code, '/tmp/x'])
  })
})
