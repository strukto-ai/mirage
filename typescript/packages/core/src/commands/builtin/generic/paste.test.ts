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
import { pasteGeneric } from './paste.ts'

function opts(flags: Record<string, string | boolean | string[]> = {}): CommandOpts {
  return { stdin: null, flags, filetypeFns: null, cwd: '/', resource: {} } as CommandOpts
}

async function* emptyStream(_path: PathSpec): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  yield new Uint8Array(0)
}

describe('pasteGeneric', () => {
  it('uses empty standard input when no operands are given', async () => {
    const result = await pasteGeneric([], opts(), emptyStream)
    expect(result).not.toBeNull()
    if (result === null) throw new Error('expected paste result')
    const [stdout, io] = result
    expect(await materialize(stdout)).toEqual(new Uint8Array(0))
    expect(io.exitCode).toBe(0)
  })

  it.each([false, true])('produces no output for an empty file with serial=%s', async (serial) => {
    const flags = serial ? { s: true } : {}
    const result = await pasteGeneric(
      [PathSpec.fromStrPath('/empty.txt')],
      opts(flags),
      emptyStream,
    )
    expect(result).not.toBeNull()
    if (result === null) throw new Error('expected paste result')
    const [stdout, io] = result
    expect(await materialize(stdout)).toEqual(new Uint8Array(0))
    expect(io.exitCode).toBe(0)
  })
})
