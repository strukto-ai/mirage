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

import { SessionProfile } from '../../policy/profile.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../workspace/workspace.ts'

const DEC = new TextDecoder()

/** A workspace whose profile protects `AWS_*` and seeds one. */
function guarded(): Workspace {
  return new Workspace(
    { '/ram': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      profiles: {
        default: SessionProfile({ vars: { protect: ['AWS_*'] }, env: { AWS_REGION: 'eu' } }),
      },
    },
  )
}

async function valueOf(ws: Workspace, name: string): Promise<string> {
  return DEC.decode((await ws.shell(`echo [$${name}]`)).stdout).trim()
}

// Every expansion-time writer below lands in the store, which refuses a
// protected name whichever door the write came in by. Mirrors
// python/tests/workspace/expand/test_session_gate.py.
const REFUSED: [string, string][] = [
  ['export AWS_PROFILE=x', 'AWS_PROFILE'],
  ['AWS_PROFILE=x', 'AWS_PROFILE'],
  ['echo "${AWS_PROFILE:=x}"', 'AWS_PROFILE'],
  ['echo $((AWS_LIMIT=5))', 'AWS_LIMIT'],
  ['v=abcdef; echo "${v:$((AWS_LIMIT=1)):2}"', 'AWS_LIMIT'],
  ['a=(one two); echo "${a[@]:${AWS_LIMIT:=1}}"', 'AWS_LIMIT'],
  ['((AWS_LIMIT=5))', 'AWS_LIMIT'],
  ['printf -v AWS_KEY %s x', 'AWS_KEY'],
  ['for ((AWS_I=0; AWS_I<1; AWS_I++)); do :; done', 'AWS_I'],
  // The write re-aims an unset reference, so the mark lands on a name the
  // assignment itself never named.
  ['declare -n ref; export ref=AWS_KEY', 'AWS_KEY'],
  ['declare -n ref; readonly ref=AWS_KEY', 'AWS_KEY'],
  ['AWS_KEY=x printenv AWS_KEY', 'AWS_KEY'],
  ['read AWS_KEY <<< x', 'AWS_KEY'],
  ['AWS_KEY+=(x)', 'AWS_KEY'],
]

const KEPT_BY_OPERATOR = [
  'AWS_REGION=us',
  'unset AWS_REGION',
  "unset 'AWS_REGION[0]'",
  'export -n AWS_REGION',
  'readonly AWS_REGION',
]

const ALLOWED: [string, string, string][] = [
  ['echo "${OTHER:=x}"', 'OTHER', '[x]'],
  ['echo $((COUNT=5))', 'COUNT', '[5]'],
  ['((COUNT=5))', 'COUNT', '[5]'],
  ['printf -v KEY %s x', 'KEY', '[x]'],
  ['for ((I=0; I<1; I++)); do :; done', 'I', '[1]'],
]

describe('every session writer refuses a protected name', () => {
  for (const [line, name] of REFUSED) {
    it(`refuses ${line}`, async () => {
      const ws = guarded()
      try {
        const result = await ws.shell(line)
        expect(result.exitCode, `${line} was not refused`).toBe(1)
        expect(DEC.decode(result.stderr)).toContain(`${name}: permission denied`)
        expect(await valueOf(ws, name), `${line} wrote anyway`).toBe('[]')
      } finally {
        await ws.close()
      }
    })
  }

  for (const line of KEPT_BY_OPERATOR) {
    it(`reads and keeps what the operator set: ${line}`, async () => {
      const ws = guarded()
      try {
        const result = await ws.shell(line)
        expect(result.exitCode, `${line} was not refused`).toBe(1)
        expect(DEC.decode(result.stderr)).toContain('AWS_REGION: permission denied')
        expect(await valueOf(ws, 'AWS_REGION')).toBe('[eu]')
        const shown = await ws.shell('declare -p AWS_REGION')
        expect(DEC.decode(shown.stdout)).toBe('declare -x AWS_REGION="eu"\n')
      } finally {
        await ws.close()
      }
    })
  }

  for (const [line, name, expected] of ALLOWED) {
    it(`still writes ${line}`, async () => {
      const ws = guarded()
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
  it('refuses a subscripted printf target', async () => {
    // `printf -v name[i]` writes the session's array table, so it is a
    // session write like any other.
    const ws = guarded()
    try {
      const result = await ws.shell("printf -v 'AWS_KEY[0]' %s x")
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toContain('AWS_KEY: permission denied')
      const after = await ws.shell('echo "[${AWS_KEY[0]}]"')
      expect(DEC.decode(after.stdout).trim()).toBe('[]')
    } finally {
      await ws.close()
    }
  })

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
      const ws = guarded()
      try {
        const result = await ws.shell(line)
        expect(DEC.decode(result.stdout).trim()).toBe(expected)
      } finally {
        await ws.close()
      }
    })
  }
})

it('does not expand length after a refused offset', async () => {
  const ws = guarded()
  try {
    const result = await ws.shell('v=abcdef; echo "${v:(AWS_LIMIT=1):${OTHER:=2}}"')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toContain('AWS_LIMIT: permission denied')
    for (const name of ['AWS_LIMIT', 'OTHER']) {
      const after = await ws.shell(`echo [$${name}]`)
      expect(DEC.decode(after.stdout).trim()).toBe('[]')
    }
  } finally {
    await ws.close()
  }
})

// The literals store first and take their marks once they all have; a
// protected later one must not leave an earlier one stored but unfrozen.
const LITERALS: [string, string][] = [
  ['readonly SAFE=(one) AWS_BLOCKED=(two)', '-ar'],
  ['export SAFE=(one) AWS_BLOCKED=(two)', '-ax'],
  ['declare -rx SAFE=(one) AWS_BLOCKED=(two)', '-arx'],
]

describe('a refused literal leaves the stored ones marked', () => {
  for (const [line, expected] of LITERALS) {
    it(line, async () => {
      const ws = guarded()
      try {
        const result = await ws.shell(line)
        expect(DEC.decode(result.stderr)).toContain('AWS_BLOCKED: permission denied')
        const shown = await ws.shell('declare -p SAFE')
        expect(DEC.decode(shown.stdout)).toBe(`declare ${expected} SAFE=([0]="one")\n`)
      } finally {
        await ws.close()
      }
    })
  }
})

it("keeps a literal's mark on the target its write cleared", async () => {
  // The literal writes through `ref` to `T`; the plain operand then re-aims
  // `ref` at `AWS_KEY`, and the literal's `-x` must not follow it to the
  // protected name. Under `-n` it marks the reference itself.
  const ws = guarded()
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
