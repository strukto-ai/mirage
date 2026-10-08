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
import { RAMAccessor } from '../../../../accessor/ram.ts'
import { mkdir } from '../../../../core/ram/mkdir.ts'
import { read } from '../../../../core/ram/read.ts'
import { write } from '../../../../core/ram/write.ts'
import { PathSpec } from '../../../../types.ts'
import { decodeBase64 } from '../../../../utils/base64.ts'
import { RAMStore } from '../../../../vfs/ram/store.ts'
import type { CommandOpts } from '../../../config.ts'
import { ioFor } from '../../../../test-utils.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { BUILDER } from './unzip.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()
// a/b.txt ("first"), then a/../b.txt ("second"), which Info-ZIP maps onto
// the same path.
const ARCHIVE = decodeBase64(
  'UEsDBBQAAAAAAAAAIVwqs0rHBgAAAAYAAAAHAAAAYS9iLnR4dGZpcnN0ClBLAwQUAAAAAAAAACFcfsAPBgcAAAAHAAAACgAAAGEvLi4vYi50eHRzZWNvbmQKUEsBAhQDFAAAAAAAAAAhXCqzSscGAAAABgAAAAcAAAAAAAAAAAAAAIABAAAAAGEvYi50eHRQSwECFAMUAAAAAAAAACFcfsAPBgcAAAAHAAAACgAAAAAAAAAAAAAAgAErAAAAYS8uLi9iLnR4dFBLBQYAAAAAAgACAG0AAABaAAAAAAA=',
)

function opts(flags: Record<string, boolean>): CommandOpts {
  return { stdin: null, flags, cwd: '/', vfs: {} } as unknown as CommandOpts
}

async function run(
  flags: Record<string, boolean>,
  before?: string,
): Promise<[string, number, string]> {
  const accessor = new RAMAccessor(new RAMStore())
  await write(accessor, PathSpec.fromStrPath('/m.zip'), ARCHIVE)
  if (before !== undefined) {
    await mkdir(accessor, PathSpec.fromStrPath('/a'))
    await write(accessor, PathSpec.fromStrPath('/a/b.txt'), ENC.encode(before))
  }
  const result = await BUILDER.fn(
    ioFor(RAMVFS, accessor),
    accessor,
    [PathSpec.fromStrPath('/m.zip')],
    [],
    opts(flags),
  )
  if (result === null) throw new Error('unzip returned nothing')
  const [, io] = result
  const kept = DEC.decode(await read(accessor, PathSpec.fromStrPath('/a/b.txt')))
  return [kept, io.exitCode, DEC.decode(await io.materializeStderr())]
}

describe('unzip without a dispatcher', () => {
  // The builder hands the generic the mount's own stat, and a member mapped
  // onto one already written is asked about, kept under -n and replaced
  // under -o, as Info-ZIP does. Mirrors test_unzip.py.
  it.each([
    [{}, 'first\n', true],
    [{ n: true }, 'first\n', false],
    [{ o: true }, 'second\n', false],
  ] as const)('sees a member it just wrote: %j', async (flags, kept, asked) => {
    const [got, code, stderr] = await run({ ...flags })
    expect(got).toBe(kept)
    expect(code).toBe(1)
    expect(stderr.includes('replace a/b.txt?')).toBe(asked)
  })

  it('never replaces a file there before the run under -n', async () => {
    const [got, code] = await run({ n: true }, 'old\n')
    expect(got).toBe('old\n')
    expect(code).toBe(1)
  })
})
