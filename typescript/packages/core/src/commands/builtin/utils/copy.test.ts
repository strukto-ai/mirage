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
import { PathSpec } from '../../../types.ts'
import { landingPath } from './copy.ts'

function spec(virtual: string, rawPath: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    vfsPath: virtual.replace(/^\/+/, ''),
    rawPath,
  })
}

// GNU appends the operand's last component as typed, so a followed link lands
// under its own name and `.` lands in the destination itself; cp lands `..`
// there too, mv in the destination's parent. Mirrors test_copy.py.
it.each([
  ['al', '/data/a.txt', '..', '/data/t/al', 't/al'],
  ['dir/al/', '/data/a.txt', '..', '/data/t/al', 't/al'],
  ['/data/x/y', '/data/x/y', '..', '/data/t/y', 't/y'],
  ['', '/data/sub', '..', '/data/t/sub', 't/sub'],
  ['.', '/data/sub', '..', '/data/t', 't/.'],
  ['s/./', '/data/s', '..', '/data/t', 't/.'],
  ['sub/..', '/data', '..', '/data', 't/..'],
  ['sub/..', '/data', '.', '/data/t', 't/.'],
])('lands %j (at %s, .. as %s) at %s, shown %s', (rawPath, virtual, dotdot, landing, shown) => {
  const got = landingPath(spec('/data/t', 't'), spec(virtual, rawPath), dotdot)
  expect([got.virtual, got.rawPath]).toEqual([landing, shown])
})
