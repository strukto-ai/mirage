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

  it('lands readonly and export on one declaration', async () => {
    // Readonly answers first, so the export stamp has to land in the
    // readonly branch too or `-r` silently eats the `-x`.
    const ws = await makeWs()
    const io = await ws.shell('declare -rx X=1; declare -p X')
    expect(stdoutStr(io)).toBe('declare -rx X="1"\n')
  })

  it('sets neither when lower and upper share a cluster', async () => {
    const ws = await makeWs()
    const io = await ws.shell('declare -lu s=aBc; declare -p s')
    expect(stdoutStr(io)).toBe('declare -- s="aBc"\n')
  })

  it('applies a shaping letter to later writes, not the held value', async () => {
    const ws = await makeWs()
    const io = await ws.shell('v=MiXeD; declare -l v; declare -p v; v=ABC; declare -p v')
    expect(stdoutStr(io)).toBe('declare -l v="MiXeD"\ndeclare -l v="abc"\n')
  })

  it('refuses to convert between the two array kinds', async () => {
    const ws = await makeWs()
    const io = await ws.shell('declare -a a; declare -A a')
    expect(stderrStr(io)).toBe('bash: declare: a: cannot convert indexed to associative array\n')
    expect(io.exitCode).toBe(1)
  })

  it('refuses +r on a readonly name and keeps it frozen', async () => {
    const ws = await makeWs()
    const io = await ws.shell('readonly r=1; declare +r r')
    expect(stderrStr(io)).toBe('bash: declare: r: readonly variable\n')
    expect(io.exitCode).toBe(1)
  })

  it('cannot destroy an indexed array with +a', async () => {
    const ws = await makeWs()
    const io = await ws.shell('a=(x); declare +a a')
    expect(stderrStr(io)).toBe('bash: declare: a: cannot destroy array variables in this way\n')
    expect(io.exitCode).toBe(1)
  })

  it('does not cost siblings their marks when one operand refuses', async () => {
    // `declare -x GOOD=1 1BAD=x` exits 1 and still exports GOOD: the
    // stamp reads the names the handler stored, not the exit code.
    const ws = await makeWs()
    const io = await ws.shell('declare -x GOOD=1 1BAD=x; declare -p GOOD')
    expect(stderrStr(io)).toContain('not a valid identifier')
    expect(stdoutStr(io)).toBe('declare -x GOOD="1"\n')
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
