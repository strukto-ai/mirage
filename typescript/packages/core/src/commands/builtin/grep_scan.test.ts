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
import { ContentType, FileStat, FileType } from '../../types.ts'
import { grepFilesOnly } from './grep_scan.ts'

const ENC = new TextEncoder()

describe('grepFilesOnly', () => {
  it('scans file operands under recursive instead of walking them', async () => {
    // GNU: `grep -rl pat file` treats the operand as a file; only directory
    // operands are walked (search-narrowed candidates arrive as files).
    const readdirFn = (path: string): Promise<string[]> => Promise.reject(new Error(path))
    const statFn = (path: string): Promise<FileStat> =>
      Promise.resolve(new FileStat({ name: path, type: FileType.FILE, content: ContentType.TEXT }))
    const readBytesFn = (): Promise<Uint8Array> => Promise.resolve(ENC.encode('alpha beta\n'))
    const hits = await grepFilesOnly(readdirFn, statFn, readBytesFn, '/data/notes.txt', 'alpha', {
      recursive: true,
      ignoreCase: false,
      invert: false,
      lineNumbers: false,
      countOnly: false,
      fixedString: false,
      onlyMatching: false,
      maxCount: null,
      wholeWord: false,
      basic: true,
    })
    expect(hits).toEqual(['/data/notes.txt'])
  })
})
