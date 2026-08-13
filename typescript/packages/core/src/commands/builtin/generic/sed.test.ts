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
import type { CommandOpts } from '../../config.ts'
import { sedGeneric } from './sed.ts'

const DEC = new TextDecoder()

async function runSed(
  texts: string[],
  flags: CommandOpts['flags'] = {},
  stdin: Uint8Array | null = null,
): Promise<{ exitCode: number; stderr: string }> {
  const opts = {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'ram' } as never,
  } as CommandOpts
  const result = await sedGeneric(
    [],
    texts,
    opts,
    () => {
      throw new Error('no operands; nothing to stream')
    },
    () => Promise.resolve(),
  )
  if (result === null) throw new Error('sed returned nothing')
  const io = result[1]
  const stderr = io.stderr === null ? '' : DEC.decode(await materialize(io.stderr))
  return { exitCode: io.exitCode, stderr }
}

describe('sed usage reporting', () => {
  it('names a missing script and exits 1', async () => {
    // GNU answers this with its whole usage block, also exit 1. Python used
    // to raise ValueError('sed: usage: sed EXPRESSION [path]') here.
    expect(await runSed([])).toEqual({ exitCode: 1, stderr: 'sed: missing script\n' })
  })

  it('reports no input files with GNU exit 4 when there is nothing to read', async () => {
    // GNU's spelling and exit code for `sed -i` with no operands; mirage
    // reuses them when there is no stdin either, having no terminal to
    // read. This used to be 'sed: missing operand' with exit 1 here and
    // ValueError('sed: usage: sed EXPRESSION path') in Python.
    expect(await runSed(['s/a/b/'])).toEqual({ exitCode: 4, stderr: 'sed: no input files\n' })
  })

  it('reports no input files for -i with no operands too', async () => {
    expect(await runSed(['s/a/b/'], { i: true })).toEqual({
      exitCode: 4,
      stderr: 'sed: no input files\n',
    })
  })
})
