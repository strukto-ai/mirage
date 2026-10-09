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

// export/local/declare/readonly, pinned against bash 5.2.37. Mirrors
// python/tests/workspace/node/test_declaration.py.

import { describe, expect, it } from 'vitest'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, shellParser: parser })
}

describe('executeDeclaration', () => {
  it('refuses an unknown option letter before any operand', async () => {
    const ws = await makeWs()
    const io = await ws.shell('declare -q NAME')
    expect(stdoutStr(io)).toBe('')
    expect(stderrStr(io)).toBe(
      'bash: declare: -q: invalid option\n' +
        'declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] ' +
        'or declare -p [-aAfFilnrtux] [name ...]\n',
    )
    expect(io.exitCode).toBe(2)
  })

  it('applies a shaping letter to later writes, not the held value', async () => {
    const ws = await makeWs()
    const io = await ws.shell('v=MiXeD; declare -l v; declare -p v; v=ABC; declare -p v')
    expect(stdoutStr(io)).toBe('declare -l v="MiXeD"\ndeclare -l v="abc"\n')
  })

  it('drops an unquoted empty expansion by word splitting', async () => {
    // `export $UNSET` is a bare `export` and prints the listing; the
    // quoted form is a real, empty operand and refuses.
    const ws = await makeWs()
    expect((await ws.shell('export $NOPE')).exitCode).toBe(0)
    const io = await ws.shell('export "$NOPE"')
    expect(stderrStr(io)).toBe("bash: export: `': not a valid identifier\n")
    expect(io.exitCode).toBe(1)
  })

  it('leaves the old value intact when a staged array literal refuses', async () => {
    // Array literals are staged, not stored, so `readonly -a a=(y)` on
    // an already-readonly name fails with the old value intact. GNU
    // treats it as a fatal variable-assignment error, so the rest of
    // that line never runs -- the value is read back on the next one.
    const ws = await makeWs()
    const io = await ws.shell('readonly -a a=(x); readonly -a a=(y); echo REACHED')
    expect(stderrStr(io)).toBe('bash: a: readonly variable\n')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(await ws.shell('declare -p a'))).toBe('declare -ar a=([0]="x")\n')
  })
})
