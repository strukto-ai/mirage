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

import type { TSNodeLike } from '../../expand/variable.ts'
import { parsedCommands } from './facts.ts'
import { policyContextFromPayload, policyContextPayload, type PolicyContext } from './types.ts'

// Mirrors python/tests/runtime/policy/test_facts.py.

function word(type: string, text: string): TSNodeLike {
  return { type, text, children: [], namedChildren: [] }
}

function command(...words: string[]): TSNodeLike {
  const children = words.map((w, i) => word(i === 0 ? 'command_name' : 'word', w))
  return { type: 'command', text: words.join(' '), children, namedChildren: children }
}

function line(...commands: TSNodeLike[]): TSNodeLike {
  return { type: 'program', text: '', children: commands, namedChildren: commands }
}

describe('parsedCommands', () => {
  it('distills words, builtin, and paths per command', () => {
    const root = line(command('cat', '/a/big.csv'), command('python3', '/r/x.py', '1'))
    const commands = parsedCommands(root)
    expect(commands.map((c) => c.command)).toEqual(['cat', 'python3'])
    expect(commands[0]?.paths).toEqual(['/a/big.csv'])
    expect(commands[1]?.words).toEqual(['python3', '/r/x.py', '1'])
    expect(commands.every((c) => c.cli === null)).toBe(true)
  })

  it('tags installed CLI heads, and only heads', () => {
    const root = line(command('slack', 'send', 'hi'), command('cat', '/x/slack'))
    const commands = parsedCommands(root, new Set(['slack']))
    expect(commands[0]?.cli).toBe('slack')
    expect(commands[1]?.cli).toBeNull()
  })
})

describe('policy context wire schema', () => {
  it('round-trips the cli fact through the payload', () => {
    const ctx: PolicyContext = {
      line: 'slack send /data/x',
      commands: [
        {
          command: 'slack',
          words: ['slack', 'send', '/data/x'],
          builtin: false,
          paths: ['/data/x'],
          cli: 'slack',
        },
      ],
      command: 'slack',
      builtin: false,
      cwd: '/data',
      env: { K: 'V' },
      sessionId: 's1',
      agentId: 'a1',
      mounts: ['/data'],
    }
    const replayed = policyContextFromPayload(
      JSON.parse(JSON.stringify(policyContextPayload(ctx))) as Record<string, unknown>,
    )
    expect(replayed).toEqual(ctx)
  })
})
