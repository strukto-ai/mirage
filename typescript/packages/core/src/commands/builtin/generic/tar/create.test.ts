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
import { stripPrefix } from './create.ts'

describe('stripPrefix', () => {
  // Every row is GNU tar 1.35 on debian:stable-slim: `tar -cf` for the
  // notice, `tar -tf` for the stored name. Mirrors the Python
  // STRIP_PREFIX_ROWS table.
  const rows: [string, string, string][] = [
    ['/data/sub/../file', 'file', '/data/sub/../'],
    ['../file', 'file', '../'],
    ['x/../y/f3', 'y/f3', 'x/../'],
    ['../../file', 'file', '../../'],
    ['/data/../data/file', 'data/file', '/data/../'],
    // No `..`, so the leading slash is the only thing tar refuses.
    ['/data/file', 'data/file', '/'],
    // A `.` climbs nowhere, so GNU stores it and says nothing.
    ['./file', './file', ''],
    ['d/a.txt', 'd/a.txt', ''],
    // Nothing survives the traversal; memberName supplies the name.
    ['..', '', '..'],
    ['sub/..', '', 'sub/..'],
  ]

  it.each(rows)('drops through the last .. in %s', (spelled, name, prefix) => {
    expect(stripPrefix(spelled)).toEqual([name, prefix])
  })
})
