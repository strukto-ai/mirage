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

// Top-level assignment spellings, pinned against bash 5.2.37. Mirrors
// python/tests/workspace/node/test_assignment.py.

import { describe, expect, it } from 'vitest'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE, shellParser: parser })
}

describe('executeAssignment', () => {
  it('appends an array literal at the extent', async () => {
    const ws = await makeWs()
    const io = await ws.shell('a=(x y); a+=(z); declare -p a')
    expect(stdoutStr(io)).toBe('declare -a a=([0]="x" [1]="y" [2]="z")\n')
  })

  it('writes element zero for a scalar on an indexed array', async () => {
    const ws = await makeWs()
    const io = await ws.shell('a=(x y); a=q; declare -p a')
    expect(stdoutStr(io)).toBe('declare -a a=([0]="q" [1]="y")\n')
  })

  it('evaluates an indexed subscript as arithmetic', async () => {
    const ws = await makeWs()
    const io = await ws.shell('a=(x y z); a[1+1]=Q; declare -p a')
    expect(stdoutStr(io)).toBe('declare -a a=([0]="x" [1]="y" [2]="Q")\n')
  })

  it('keeps an associative subscript as a literal key', async () => {
    const ws = await makeWs()
    const io = await ws.shell('declare -A m; m[1+1]=v; declare -p m')
    expect(stdoutStr(io)).toBe('declare -A m=([1+1]="v" )\n')
  })

  it('writes key zero for a scalar on an associative array', async () => {
    const ws = await makeWs()
    const io = await ws.shell('declare -A m; m[k]=v; m=x; declare -p m')
    expect(stdoutStr(io)).toContain('[0]="x"')
    expect(stdoutStr(io)).toContain('[k]="v"')
  })

  it('adds rather than concatenates when appending to an integer name', async () => {
    const ws = await makeWs()
    const io = await ws.shell('declare -i n=5; n+=3; echo $n')
    expect(stdoutStr(io)).toBe('8\n')
  })

  it('aborts the line on an associative subscript that expands empty', async () => {
    // GNU 5.2.37 names the raw spelling, not the expanded key, and the
    // rest of the line is abandoned.
    const ws = await makeWs()
    const io = await ws.shell('declare -A m; e=; m[$e]=v; echo REACHED')
    expect(stdoutStr(io)).toBe('')
    expect(stderrStr(io)).toBe('bash: m[$e]: bad array subscript\n')
    expect(io.exitCode).toBe(1)
  })

  it('keeps an indexed subscript that expands empty legal', async () => {
    // The asymmetry above: arithmetic on nothing is 0, so only the
    // associative kind checks the expanded text.
    const ws = await makeWs()
    const io = await ws.shell('a=(x y); e=; a[$e]=Q; declare -p a')
    expect(stdoutStr(io)).toBe('declare -a a=([0]="Q" [1]="y")\n')
    expect(io.exitCode).toBe(0)
  })

  it('aborts the line when assigning a readonly name', async () => {
    const ws = await makeWs()
    const io = await ws.shell('readonly r=1; r=2; echo REACHED')
    expect(stdoutStr(io)).toBe('')
    expect(stderrStr(io)).toBe('bash: r: readonly variable\n')
    expect(io.exitCode).toBe(1)
  })

  it('takes the last substitution across every assignment of a statement', async () => {
    const ws = await makeWs()
    const io = await ws.shell('a=$(true) b=$(false)')
    expect(io.exitCode).toBe(1)
  })
})
