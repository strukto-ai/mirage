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

import type { Policy } from '../../policy/base.ts'
import type { Action, SessionContext } from '../../policy/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace.ts'

const DEC = new TextDecoder()

class DenyAws implements Policy {
  preSession(ctx: SessionContext): Action | null {
    if (!ctx.key.startsWith('AWS_')) return null
    return { kind: 'deny', message: 'not yours to set\n' }
  }
}

async function guarded(): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/ram': new RAMResource() },
    {
      mode: MountMode.WRITE,
      shellParserFactory: () => Promise.resolve(parser),
      policies: [new DenyAws()],
    },
  )
}

// Every expansion-time writer below reached the session env directly, so a
// preSession rule was one `${X:=}` away from being irrelevant. Mirrors
// python/tests/workspace/expand/test_session_gate.py.
const REFUSED: [string, string][] = [
  ['export AWS_PROFILE=x', 'AWS_PROFILE'],
  ['AWS_PROFILE=x', 'AWS_PROFILE'],
  ['echo "${AWS_PROFILE:=x}"', 'AWS_PROFILE'],
  ['echo $((AWS_LIMIT=5))', 'AWS_LIMIT'],
  ['((AWS_LIMIT=5))', 'AWS_LIMIT'],
  ['printf -v AWS_KEY %s x', 'AWS_KEY'],
  ['for ((AWS_I=0; AWS_I<1; AWS_I++)); do :; done', 'AWS_I'],
]

const ALLOWED: [string, string, string][] = [
  ['echo "${OTHER:=x}"', 'OTHER', '[x]'],
  ['echo $((COUNT=5))', 'COUNT', '[5]'],
  ['((COUNT=5))', 'COUNT', '[5]'],
  ['printf -v KEY %s x', 'KEY', '[x]'],
  ['for ((I=0; I<1; I++)); do :; done', 'I', '[1]'],
]

describe('every session writer clears the pre_session gate', () => {
  for (const [line, name] of REFUSED) {
    it(`refuses ${line}`, async () => {
      const ws = await guarded()
      try {
        const result = await ws.execute(line)
        expect(result.exitCode, `${line} was not refused`).not.toBe(0)
        expect(DEC.decode(result.stderr)).toContain('not yours to set')
        const after = await ws.execute(`echo [$${name}]`)
        expect(DEC.decode(after.stdout).trim(), `${line} wrote anyway`).toBe('[]')
      } finally {
        await ws.close()
      }
    })
  }

  for (const [line, name, expected] of ALLOWED) {
    it(`still writes ${line}`, async () => {
      const ws = await guarded()
      try {
        await ws.execute(line)
        const after = await ws.execute(`echo [$${name}]`)
        expect(DEC.decode(after.stdout).trim()).toBe(expected)
      } finally {
        await ws.close()
      }
    })
  }
})
