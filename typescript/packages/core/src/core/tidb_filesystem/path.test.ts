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
import { normalizeTiDBFilesystemConfig } from '../../vfs/tidb_filesystem/config.ts'
import { backendPath } from './path.ts'

function config(root: string): ReturnType<typeof normalizeTiDBFilesystemConfig> {
  return normalizeTiDBFilesystemConfig({ host: 'http://drive9', token: 't', root_path: root })
}

describe('backendPath', () => {
  it.each([
    ['/', '/', '/'],
    ['/', '/a/b', '/a/b'],
    ['/proj', '/', '/proj'],
    ['/proj', '/a/./b/', '/proj/a/b'],
  ])('joins root %s and %s', (root, path, expected) => {
    expect(backendPath(config(root), path)).toBe(expected)
  })

  it('refuses an escape', () => {
    expect(() => backendPath(config('/proj'), '/../x')).toThrow()
  })
})
