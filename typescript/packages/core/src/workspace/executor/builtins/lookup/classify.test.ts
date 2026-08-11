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
import { CLISpec } from '../../../../commands/cli/types.ts'
import { IOResult } from '../../../../io/types.ts'
import { CLIRegistry } from '../../../cli/registry.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import { Session } from '../../../session/session.ts'
import { classify, classifyAll } from './classify.ts'
import { NameKind } from './types.ts'

// Mirrors python/tests/workspace/executor/builtins/lookup/test_classify.py.

const MOUNT_COMMANDS = new Set(['cat', 'grep', 'ls', 'jq'])

function noop(): [null, IOResult] {
  return [null, new IOResult()]
}

const TREE = new CLISpec({
  name: 'linear',
  subcommands: [new CLISpec({ name: 'issue', fn: noop })],
})

function makeRegistry(withCli = false): MountRegistry {
  const clis = new CLIRegistry()
  if (withCli) clis.install('linear', TREE)
  return {
    mountForCommand: (name: string): unknown => (MOUNT_COMMANDS.has(name) ? {} : null),
    clis,
  } as unknown as MountRegistry
}

function makeSession(): Session {
  return new Session({ sessionId: 's1' })
}

describe('classify', () => {
  it('names each layer', () => {
    const session = makeSession()
    const registry = makeRegistry(true)
    session.functions.deploy = 'deploy() { :; }'
    expect(classify('if', session, registry)).toBe(NameKind.KEYWORD)
    expect(classify('deploy', session, registry)).toBe(NameKind.FUNCTION)
    expect(classify('linear', session, registry)).toBe(NameKind.CLI)
    expect(classify('cd', session, registry)).toBe(NameKind.BUILTIN)
    expect(classify('cat', session, registry)).toBe(NameKind.BUILTIN)
    expect(classify('nope', session, registry)).toBeNull()
  })

  it('classifyAll reports a function shadowing a CLI, winner first', () => {
    const session = makeSession()
    const registry = makeRegistry(true)
    expect(classifyAll('linear', session, registry)).toEqual([NameKind.CLI])
    session.functions.linear = 'linear() { :; }'
    expect(classifyAll('linear', session, registry)).toEqual([NameKind.FUNCTION, NameKind.CLI])
  })

  it('keeps the layers under a keyword', () => {
    // bash: `function time { :; }; type -a time` prints the keyword line
    // then the function line.
    const session = makeSession()
    session.functions.then = 'then() { :; }'
    expect(classifyAll('then', session, makeRegistry())).toEqual([
      NameKind.KEYWORD,
      NameKind.FUNCTION,
    ])
  })

  it('does not call time or coproc keywords', () => {
    // mirage implements neither construct, so `time echo hi` reports
    // command not found and type may not call it a keyword.
    const session = makeSession()
    const registry = makeRegistry()
    expect(classify('time', session, registry)).toBeNull()
    expect(classify('coproc', session, registry)).toBeNull()
    session.functions.time = 'time() { :; }'
    expect(classify('time', session, registry)).toBe(NameKind.FUNCTION)
  })
})
