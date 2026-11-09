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
import { runExplaining } from '../../context/session_context.ts'
import { DryRun } from '../../policy/types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { stderrStr, stdoutStr } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

function makeWs(): Workspace {
  return new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
}

describe('executeDeclaration', () => {
  it.each([
    ['export A=1', 'A'],
    ['export B', 'B'],
    ['readonly C=1', 'C'],
    ['declare D=1', 'D'],
    ['declare -x E', 'E'],
    ['declare -a F=(a b)', 'F'],
    ['declare -a G', 'G'],
  ])('refuses a deciding policy writing with %s', async (line, name) => {
    const ws = makeWs()
    const io = await runExplaining(DryRun.DECIDING, () => ws.shell(line))
    expect(stderrStr(io)).toBe(`${name}: permission denied\n`)
    expect(io.exitCode).toBe(1)
    expect((await ws.shell(`declare -p ${name}`)).exitCode).toBe(1)
  })

  it.each([
    ['Y=1', 'Y: permission denied\n'],
    ['let Y=1', 'Y: permission denied\n'],
    ['((Y=1))', 'bash: line 1: Y: permission denied\n'],
  ])('refuses a deciding policy assigning with %s', async (line, said) => {
    const ws = makeWs()
    const io = await runExplaining(DryRun.DECIDING, () => ws.shell(line))
    expect(stderrStr(io)).toBe(said)
    expect(io.exitCode).toBe(1)
    expect((await ws.shell('declare -p Y')).exitCode).toBe(1)
  })

  it('refuses a deciding policy unsetting', async () => {
    const ws = makeWs()
    await ws.shell('HELD=1; A=(x y)')
    const io = await runExplaining(DryRun.DECIDING, () => ws.shell("unset HELD 'A[0]'"))
    expect(stderrStr(io)).toBe('HELD: permission denied\nA: permission denied\n')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(await ws.shell('echo "$HELD ${A[0]}"'))).toBe('1 x\n')
  })

  it('refuses a deciding policy a local and lets it list', async () => {
    const ws = makeWs()
    await ws.shell('HELD=1')
    const io = await runExplaining(DryRun.DECIDING, () =>
      ws.shell('f() { local L=1; echo "in=$L"; }; f; declare -p HELD'),
    )
    expect(stdoutStr(io)).toBe('in=\ndeclare -- HELD="1"\n')
    expect(stderrStr(io)).toBe('L: permission denied\n')
  })

  it('refuses an unknown option letter before any operand', async () => {
    const ws = makeWs()
    const io = await ws.shell('declare -q NAME')
    expect(stdoutStr(io)).toBe('')
    expect(stderrStr(io)).toBe(
      'bash: line 1: declare: -q: invalid option\n' +
        'declare: usage: declare [-aAfFgiIlnrtux] [name[=value] ...] ' +
        'or declare -p [-aAfFilnrtux] [name ...]\n',
    )
    expect(io.exitCode).toBe(2)
  })

  it('applies a shaping letter to later writes, not the held value', async () => {
    const ws = makeWs()
    const io = await ws.shell('v=MiXeD; declare -l v; declare -p v; v=ABC; declare -p v')
    expect(stdoutStr(io)).toBe('declare -l v="MiXeD"\ndeclare -l v="abc"\n')
  })

  it('drops an unquoted empty expansion by word splitting', async () => {
    // `export $UNSET` is a bare `export` and prints the listing; the
    // quoted form is a real, empty operand and refuses.
    const ws = makeWs()
    expect((await ws.shell('export $NOPE')).exitCode).toBe(0)
    const io = await ws.shell('export "$NOPE"')
    expect(stderrStr(io)).toBe("bash: line 1: export: `': not a valid identifier\n")
    expect(io.exitCode).toBe(1)
  })

  it('leaves the old value intact when a staged array literal refuses', async () => {
    // Array literals are staged, not stored, so `readonly -a a=(y)` on
    // an already-readonly name fails with the old value intact. GNU
    // treats it as a fatal variable-assignment error, so the rest of
    // that line never runs -- the value is read back on the next one.
    const ws = makeWs()
    const io = await ws.shell('readonly -a a=(x); readonly -a a=(y); echo REACHED')
    expect(stderrStr(io)).toBe('bash: line 1: a: readonly variable\n')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(await ws.shell('declare -p a'))).toBe('declare -ar a=([0]="x")\n')
  })
})
