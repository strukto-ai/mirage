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

import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../workspace/workspace.ts'

const DEC = new TextDecoder()

function plain(): Workspace {
  return new Workspace({ '/ram': new RAMVFS() }, { mode: MountMode.WRITE })
}

// Every expansion-time writer lands in the session. Mirrors
// python/tests/workspace/expand/test_session_gate.py.
const WRITTEN: [string, string, string][] = [
  ['echo "${OTHER:=x}"', 'OTHER', '[x]'],
  ['echo $((COUNT=5))', 'COUNT', '[5]'],
  ['((COUNT=5))', 'COUNT', '[5]'],
  ['printf -v KEY %s x', 'KEY', '[x]'],
  ['for ((I=0; I<1; I++)); do :; done', 'I', '[1]'],
]

describe('every expansion-time writer lands', () => {
  for (const [line, name, expected] of WRITTEN) {
    it(`writes ${line}`, async () => {
      const ws = plain()
      try {
        await ws.shell(line)
        const after = await ws.shell(`echo [$${name}]`)
        expect(DEC.decode(after.stdout).trim()).toBe(expected)
      } finally {
        await ws.close()
      }
    })
  }
})

describe('a session write states itself as a whole variable', () => {
  // bash 5.2: an arithmetic assignment to an array name writes element
  // 0 and leaves the rest of the array alone, and so does a `${name:=}`
  // default. Writing the whole variable as a scalar instead discards
  // every element after the first.
  const KEPT: [string, string][] = [
    ['A=(1 2 3); echo $((A=5)) >/dev/null; echo "${A[@]}"', '5 2 3'],
    ['C=("" 9); echo "${C:=x}" >/dev/null; echo "${C[@]}"', 'x 9'],
    ['B=(1 2 3); printf -v B %s X; echo "${B[@]}"', 'X 2 3'],
    ['D=(1 2 3); printf -v \'D[1]\' %s Y; echo "${D[@]}"', '1 Y 3'],
  ]
  for (const [line, expected] of KEPT) {
    it(`keeps the other elements: ${line}`, async () => {
      const ws = plain()
      try {
        const result = await ws.shell(line)
        expect(DEC.decode(result.stdout).trim()).toBe(expected)
      } finally {
        await ws.close()
      }
    })
  }
})

it("keeps a literal's mark on the target its write cleared", async () => {
  // The literal writes through `ref` to `T`; the plain operand then re-aims
  // `ref` at `AWS_KEY`, and the literal's `-x` must not follow it there.
  // Under `-n` it marks the reference itself.
  const ws = plain()
  try {
    const result = await ws.shell('T=old; declare -n ref=T; declare -nx ref=AWS_KEY ref=(one)')
    expect(result.exitCode).toBe(0)
    const shown = await ws.shell('declare -p ref AWS_KEY')
    expect(DEC.decode(shown.stdout)).toBe('declare -nx ref="AWS_KEY"\n')
    expect(DEC.decode(shown.stderr)).toContain('AWS_KEY: not found')
  } finally {
    await ws.close()
  }
})
