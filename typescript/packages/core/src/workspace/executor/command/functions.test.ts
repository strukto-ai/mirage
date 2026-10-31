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
import { NESTING_MAX } from '../../../shell/constants.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace.ts'

const DEC = new TextDecoder()

async function run(line: string): Promise<[string, string, number]> {
  const ws = new Workspace({ '/r/': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    const io = await ws.shell(line)
    return [DEC.decode(io.stdout), DEC.decode(io.stderr), io.exitCode]
  } finally {
    await ws.close()
  }
}

function refused(name: string, limit: number): string {
  return `bash: ${name}: maximum function nesting level exceeded (${String(limit)})\n`
}

describe('function nesting limit', () => {
  it('a call past the limit abandons the line', async () => {
    const [out, err, code] = await run('f() { echo "d$1"; f $(($1+1)); }; f 1; echo same-line')
    expect(out.split('\n').filter((l) => l !== '')).toEqual(
      Array.from({ length: NESTING_MAX }, (_, i) => `d${String(i + 1)}`),
    )
    expect(err).toBe(refused('f', NESTING_MAX))
    expect(code).toBe(1)
  })

  it('substitution recursion stops at the limit', async () => {
    expect(await run('f() { echo $(f); }; f; echo "next $?"')).toEqual([
      '\nnext 0\n',
      refused('f', NESTING_MAX),
      0,
    ])
  })

  it('FUNCNEST lowers the limit', async () => {
    expect(await run('FUNCNEST=" +2 "; f() { echo "d$1"; f $(($1+1)); }; f 1')).toEqual([
      'd1\nd2\n',
      refused('f', 2),
      1,
    ])
  })

  it.each(['100', '0', '-1', '3x', '', '9'.repeat(5000)])(
    'FUNCNEST=%# never raises the limit',
    async (value) => {
      const [, err, code] = await run(`FUNCNEST="${value}"; f() { f; }; f`)
      expect([err, code]).toEqual([refused('f', NESTING_MAX), 1])
    },
  )

  it('a sourced file is not a function level', async () => {
    expect(
      await run('echo g > /r/s.sh; FUNCNEST=2; g() { echo g; }; f() { source /r/s.sh; }; f'),
    ).toEqual(['g\n', '', 0])
  })
})
