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
import { lineFacts } from '../../../workspace/lookup/constants.ts'

it.each([
  [['xz', '-t', '/d/a'], false],
  [['xz', '-t', '-z', '/d/a'], true],
  [['xz', '-z', '-t', '/d/a'], false],
  [['xz', '-t', '-d', '/d/a'], true],
  [['xz', '-c', '-t', '-z', '/d/a'], false],
  [['bzip2', '-t', '-z', '/d/a'], true],
  [['bzip2', '-z', '-t', '/d/a'], false],
])('the last mode decides whether %j writes', (words, writes) => {
  expect(lineFacts(words[0] ?? '', words, '/').writes).toBe(writes)
})
