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
import { PathSpec, materialize, type Resource } from '@struktoai/mirage-core'
import type { SSHAccessor } from '../../../../accessor/ssh.ts'
import { makeFakeAccessor } from '../../../../core/ssh/_test_utils.ts'
import { SSH_COMMANDS } from '../index.ts'
const SSH_LS = SSH_COMMANDS.filter((c) => c.name === 'ls' && c.filetype == null)

const DEC = new TextDecoder()

async function runLs(
  accessor: SSHAccessor,
  paths: PathSpec[],
  flags: Record<string, string | boolean> = {},
): Promise<string> {
  const cmd = SSH_LS[0]
  if (cmd === undefined) throw new Error('ls not registered')
  const result = await cmd.fn(accessor, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null as unknown as Resource,
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

function mixedCaseAccessor(): SSHAccessor {
  return makeFakeAccessor({
    files: new Map([
      ['/data/apple.txt', { data: new Uint8Array() }],
      ['/data/Banana.txt', { data: new Uint8Array() }],
      ['/data/CHERRY.txt', { data: new Uint8Array() }],
    ]),
    dirs: new Map([
      ['/', {}],
      ['/data', {}],
    ]),
  })
}

describe('ssh ls', () => {
  it('sorts names by ASCII byte order, uppercase before lowercase', async () => {
    const accessor = mixedCaseAccessor()
    const out = await runLs(accessor, [PathSpec.fromStrPath('/data')])
    expect(out.trimEnd().split('\n')).toEqual(['Banana.txt', 'CHERRY.txt', 'apple.txt'])
  })

  it('-r reverses the ASCII order', async () => {
    const accessor = mixedCaseAccessor()
    const out = await runLs(accessor, [PathSpec.fromStrPath('/data')], { r: true })
    expect(out.trimEnd().split('\n')).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })
})
