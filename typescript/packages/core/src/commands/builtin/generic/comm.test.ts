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
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { commGeneric } from './comm.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const FILES: Record<string, string> = {
  '/left.txt': 'b\na\n',
  '/right.txt': 'b\nc\n',
}

function opts(flags: Record<string, string | boolean | string[]>): CommandOpts {
  return { stdin: null, flags, filetypeFns: null, cwd: '/', resource: {} } as CommandOpts
}

async function* stream(path: PathSpec): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield ENC.encode(FILES[path.virtual] ?? '')
}

describe('commGeneric', () => {
  it('--check-order exits nonzero for unsorted input', async () => {
    const result = await commGeneric(
      [PathSpec.fromStrPath('/left.txt'), PathSpec.fromStrPath('/right.txt')],
      opts({ check_order: true }),
      stream,
    )
    expect(result).not.toBeNull()
    if (result === null) throw new Error('expected comm result')
    const [, io] = result
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(await materialize(io.stderr))).toBe('comm: file 1 is not in sorted order\n')
  })
})
