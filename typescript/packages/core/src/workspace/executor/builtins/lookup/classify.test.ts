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
import { CommandSpec } from '../../../../commands/spec/types.ts'
import { CLIHandler } from '../../../../commands/cli/types.ts'

import { describe, expect, it } from 'vitest'
import { CLI } from '../../../../commands/cli/types.ts'
import { IOResult } from '../../../../io/types.ts'
import { CLIRegistry } from '../../../cli/registry.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import { SessionState } from '../../../session/session.ts'
import { classify, classifyAll } from './classify.ts'
import { NameKind } from './types.ts'

// Mirrors python/tests/workspace/executor/builtins/lookup/test_classify.py.

const MOUNT_COMMANDS = new Set(['cat', 'grep', 'ls', 'jq'])

function noop(): [null, IOResult] {
  return [null, new IOResult()]
}

const TREE = new CLI({
  spec: new CommandSpec({ name: 'linear', subcommands: [new CommandSpec({ name: 'issue' })] }),
  handlers: { issue: new CLIHandler({ fn: noop }) },
})

function makeRegistry(withCli = false): MountRegistry {
  const clis = new CLIRegistry()
  if (withCli) clis.install('linear', TREE)
  return {
    runtimeEntries: [],
    mountForCommand: (name: string): unknown => (MOUNT_COMMANDS.has(name) ? {} : null),
    clis,
  } as unknown as MountRegistry
}

function makeSession(): SessionState {
  return new SessionState({ sessionId: 's1' })
}

describe('classify', () => {
  it('names each layer', () => {
    const session = makeSession()
    const registry = makeRegistry(true)
    session.functions.deploy = 'deploy() { :; }'
    expect(classify('if', session, registry)).toBe(NameKind.KEYWORD)
    expect(classify('deploy', session, registry)).toBe(NameKind.FUNCTION)
    expect(classify('linear', session, registry)).toBe(NameKind.FILE)
    expect(classify('cd', session, registry)).toBe(NameKind.BUILTIN)
    expect(classify('cat', session, registry)).toBe(NameKind.FILE)
    // Not one of bash's builtins, so a program with a file (GNU xargs).
    expect(classify('xargs', session, registry)).toBe(NameKind.FILE)
    expect(classify('nope', session, registry)).toBeNull()
  })

  it('classifyAll reports a function shadowing a CLI, winner first', () => {
    const session = makeSession()
    const registry = makeRegistry(true)
    expect(classifyAll('linear', session, registry)).toEqual([NameKind.FILE])
    session.functions.linear = 'linear() { :; }'
    expect(classifyAll('linear', session, registry)).toEqual([NameKind.FUNCTION, NameKind.FILE])
  })

  it('classifyAll ends a builtin that is also a program with its file', () => {
    // bash: `type -a echo` prints the builtin line, then /usr/bin/echo.
    const registry = makeRegistry(true)
    expect(classifyAll('echo', makeSession(), registry)).toEqual([NameKind.BUILTIN, NameKind.FILE])
    expect(classifyAll('cd', makeSession(), registry)).toEqual([NameKind.BUILTIN])
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

  it('recognizes time while leaving coproc unimplemented', () => {
    const session = makeSession()
    const registry = makeRegistry()
    expect(classify('time', session, registry)).toBe(NameKind.KEYWORD)
    expect(classify('coproc', session, registry)).toBeNull()
    session.functions.time = 'time() { :; }'
    expect(classify('time', session, registry)).toBe(NameKind.KEYWORD)
  })
})
