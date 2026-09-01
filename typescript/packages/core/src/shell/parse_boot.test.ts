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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createShellParser } from './parse/index.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

// This file must hold the only parser in its module graph, because the boot it
// guards happens once per graph. A test that shares a file with an already
// booted parser cannot see the race.
describe('createShellParser boots once under concurrency', () => {
  it('builds every parser when several are created at the same time', async () => {
    const parsers = await Promise.all(
      Array.from({ length: 8 }, () => createShellParser({ engineWasm, grammarWasm })),
    )
    expect(parsers).toHaveLength(8)
    for (const parser of parsers) {
      const root = parser.parse('echo hello')
      expect(root.type).toBe('program')
      expect(root.hasError).toBe(false)
    }
  })
})
