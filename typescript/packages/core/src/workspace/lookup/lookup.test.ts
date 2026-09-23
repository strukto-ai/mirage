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
import { CLISpec } from '../../commands/cli/types.ts'
import { IOResult } from '../../io/types.ts'
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import {
  Consumer,
  SHELL_CONSUMERS,
  commandVisible,
  dereferences,
  readsSubtrees,
  lookup,
  lookupAll,
  verbVisible,
  walksMounts,
} from './index.ts'
import { SessionState } from '../session/session.ts'
import { Workspace } from '../workspace/workspace.ts'

function fixture(): { session: SessionState; ws: Workspace } {
  const ram = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(ram)
  const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE, ops: registry })
  return { session: new SessionState({ sessionId: 't' }), ws }
}

function noopVerb(): [null, IOResult] {
  return [null, new IOResult()]
}

function cliTree(): CLISpec {
  return new CLISpec({ name: 'prog', subcommands: [new CLISpec({ name: 'run', fn: noopVerb })] })
}

describe('lookup', () => {
  it('routes builtins to SESSION', () => {
    const { session, ws } = fixture()
    for (const name of ['cd', 'echo', 'export', 'history', 'test', 'xargs']) {
      expect(lookup(name, session, ws.registry)).toBe(Consumer.SESSION)
    }
  })

  it('routes unsupported builtins to SESSION', () => {
    const { session, ws } = fixture()
    expect(lookup('exec', session, ws.registry)).toBe(Consumer.SESSION)
  })

  it('routes namespace commands', () => {
    const { session, ws } = fixture()
    expect(lookup('ln', session, ws.registry)).toBe(Consumer.NAMESPACE)
    expect(lookup('readlink', session, ws.registry)).toBe(Consumer.NAMESPACE)
  })

  it('routes user functions to FUNCTION', () => {
    const { session, ws } = fixture()
    session.functions.greet = []
    expect(lookup('greet', session, ws.registry)).toBe(Consumer.FUNCTION)
  })

  it('builtin shadows a function of the same name', () => {
    const { session, ws } = fixture()
    session.functions.echo = []
    expect(lookup('echo', session, ws.registry)).toBe(Consumer.SESSION)
  })

  it('function shadows a mount command', () => {
    const { session, ws } = fixture()
    session.functions.cat = []
    expect(lookup('cat', session, ws.registry)).toBe(Consumer.FUNCTION)
  })

  it('routes registered mount commands to MOUNT', () => {
    const { session, ws } = fixture()
    expect(lookup('cat', session, ws.registry)).toBe(Consumer.MOUNT)
    expect(lookup('grep', session, ws.registry)).toBe(Consumer.MOUNT)
  })

  it('routes unregistered names to UNKNOWN', () => {
    const { session, ws } = fixture()
    expect(lookup('nosuchcmd', session, ws.registry)).toBe(Consumer.UNKNOWN)
  })

  it('routes an installed CLI to CLI', () => {
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    expect(lookup('prog', session, ws.registry)).toBe(Consumer.CLI)
  })

  it('function shadows an installed CLI', () => {
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    session.functions.prog = []
    expect(lookup('prog', session, ws.registry)).toBe(Consumer.FUNCTION)
  })

  it('an unregistered CLI routes UNKNOWN', () => {
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    ws.unregisterCli('prog')
    expect(lookup('prog', session, ws.registry)).toBe(Consumer.UNKNOWN)
  })

  it('only shell consumers resolve globs', () => {
    expect(SHELL_CONSUMERS.has(Consumer.SESSION)).toBe(true)
    expect(SHELL_CONSUMERS.has(Consumer.NAMESPACE)).toBe(true)
    expect(SHELL_CONSUMERS.has(Consumer.FUNCTION)).toBe(true)
    // A CLI is a program: bash hands programs glob matches, never
    // patterns.
    expect(SHELL_CONSUMERS.has(Consumer.CLI)).toBe(true)
    expect(SHELL_CONSUMERS.has(Consumer.MOUNT)).toBe(false)
    expect(SHELL_CONSUMERS.has(Consumer.UNKNOWN)).toBe(false)
  })
})

describe('lookupAll', () => {
  it('reports every layer, winner first', () => {
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    expect(lookupAll('prog', session, ws.registry)).toEqual([Consumer.CLI])
    session.functions.prog = 'prog() { :; }'
    expect(lookupAll('prog', session, ws.registry)).toEqual([Consumer.FUNCTION, Consumer.CLI])
  })

  it('is empty where lookup says UNKNOWN', () => {
    const { session, ws } = fixture()
    expect(lookupAll('bogus', session, ws.registry)).toEqual([])
    expect(lookup('bogus', session, ws.registry)).toBe(Consumer.UNKNOWN)
  })

  it('agrees with lookup on the winner', () => {
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    session.functions.greet = 'greet() { :; }'
    for (const name of ['cd', 'ln', 'greet', 'prog', 'cat', 'bogus']) {
      const layers = lookupAll(name, session, ws.registry)
      expect(lookup(name, session, ws.registry)).toBe(layers[0] ?? Consumer.UNKNOWN)
    }
  })
})

describe('find link-policy options', () => {
  it('takes the last of -P/-H/-L', () => {
    // GNU: `find -L -P x` does not follow, `find -P -L x` does.
    expect(dereferences('find', ['find', '-L', '-P', '/data/link'])).toBe(false)
    expect(dereferences('find', ['find', '-P', '-L', '/data/link'])).toBe(true)
    expect(dereferences('find', ['find', '-L', '-P', '-L', '/data/link'])).toBe(true)
    expect(dereferences('find', ['find', '-H', '/data/link'])).toBe(true)
    expect(dereferences('find', ['find', '/data/link'])).toBe(false)
  })

  it('only counts options before the operand', () => {
    expect(dereferences('find', ['find', '/data/link', '-L'])).toBe(false)
  })
})

describe('walkers and subtree readers', () => {
  it('walkers are read off the raw line', () => {
    // find/du/tree/rg always descend; grep and ls only under a flag,
    // read raw because admission fires before flag parsing.
    expect(walksMounts('find', ['find', '/data'])).toBe(true)
    expect(walksMounts('du', ['du', '/data'])).toBe(true)
    expect(walksMounts('tree', ['tree'])).toBe(true)
    expect(walksMounts('rg', ['rg', 'x'])).toBe(true)
    expect(walksMounts('grep', ['grep', 'x', '/data'])).toBe(false)
    expect(walksMounts('grep', ['grep', '-rn', 'x', '/data'])).toBe(true)
    expect(walksMounts('grep', ['grep', '--recursive', 'x'])).toBe(true)
    expect(walksMounts('grep', ['grep', '--', '-r'])).toBe(false)
    expect(walksMounts('ls', ['ls', '-R', '/data'])).toBe(true)
    expect(walksMounts('ls', ['ls', '-l', '/data'])).toBe(false)
    expect(walksMounts('cat', ['cat', '/data/x'])).toBe(false)
  })

  it('subtree readers cover the archivers and recursive copy', () => {
    // tar -c and zip -r and cp -r read below their operands but stop at
    // a mount boundary, so they read subtrees without walking mounts.
    expect(readsSubtrees('tar', ['tar', '-cf', '/out.tar', '/data'])).toBe(true)
    expect(readsSubtrees('tar', ['tar', '-xf', '/out.tar'])).toBe(false)
    expect(readsSubtrees('zip', ['zip', '-r', '/out.zip', '/data'])).toBe(true)
    expect(readsSubtrees('cp', ['cp', '-r', '/data', '/copy'])).toBe(true)
    expect(readsSubtrees('cp', ['cp', '/data/a', '/copy'])).toBe(false)
    expect(readsSubtrees('grep', ['grep', '-r', 'x', '/data'])).toBe(true)
    expect(walksMounts('tar', ['tar', '-cf', '/out.tar', '/data'])).toBe(false)
  })
})

describe('allow lists', () => {
  it('verbVisible answers below the head word commandVisible answers', () => {
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    session.commands = { allow: ['prog run'], ask: [], deny: [] }
    // Dispatch routes by the head word, which stays visible: one line
    // of the tree runs.
    expect(commandVisible('prog', session)).toBe(true)
    expect(lookup('prog', session, ws.registry)).toBe(Consumer.CLI)
    expect(verbVisible('prog', [], session)).toBe(true)
    expect(verbVisible('prog', ['run'], session)).toBe(true)
    // A verb the list does not reach is not this session's to discover,
    // though the head word it hangs off is.
    expect(verbVisible('prog', ['stop'], session)).toBe(false)
    // No list: every verb of every tree.
    session.commands = null
    expect(verbVisible('prog', ['stop'], session)).toBe(true)
  })

  it('filter every layer and spare only functions', () => {
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    session.commands = { allow: ['cat', 'prog', 'ln'], ask: [], deny: [] }
    const reg = ws.registry
    // Listed: visible in its layer, whichever layer that is.
    expect(lookup('cat', session, reg)).toBe(Consumer.MOUNT)
    expect(lookup('prog', session, reg)).toBe(Consumer.CLI)
    expect(lookup('ln', session, reg)).toBe(Consumer.NAMESPACE)
    // Unlisted: not a command for the session (sleep is a tool-tier
    // builtin, rm a mount command).
    expect(lookup('sleep', session, reg)).toBe(Consumer.UNKNOWN)
    expect(lookup('rm', session, reg)).toBe(Consumer.UNKNOWN)
    expect(lookupAll('rm', session, reg)).toEqual([])
    expect(commandVisible('rm', session)).toBe(false)
    // Builtins are subjects like everything else: an allow list stating
    // cat leaves no cd and no echo.
    expect(lookup('cd', session, reg)).toBe(Consumer.UNKNOWN)
    expect(lookup('echo', session, reg)).toBe(Consumer.UNKNOWN)
    expect(commandVisible('cd', session)).toBe(false)
    session.commands = { allow: ['cat', 'prog', 'ln', 'cd'], ask: [], deny: [] }
    expect(lookup('cd', session, reg)).toBe(Consumer.SESSION)
    expect(commandVisible('cd', session)).toBe(true)
    session.commands = { allow: ['cat', 'prog', 'ln'], ask: [], deny: [] }
    // A function is the session's own state, visible where it is what
    // runs; named after a hidden builtin it is as unreachable as the
    // builtin, since builtins shadow functions here.
    session.functions.deploy = []
    expect(lookup('deploy', session, reg)).toBe(Consumer.FUNCTION)
    expect(commandVisible('deploy', session)).toBe(true)
    session.functions.sleep = []
    expect(lookup('sleep', session, reg)).toBe(Consumer.UNKNOWN)
    expect(commandVisible('sleep', session)).toBe(false)
    // A function shadowing a hidden CLI or mount command runs, and the
    // hidden layer stays out of `type -a`.
    session.functions.rm = []
    expect(lookupAll('rm', session, reg)).toEqual([Consumer.FUNCTION])
    // No allow list at all: nothing filtered (the function still
    // shadows).
    session.commands = null
    expect(lookupAll('rm', session, reg)).toEqual([Consumer.FUNCTION, Consumer.MOUNT])
    expect(lookup('sleep', session, reg)).toBe(Consumer.SESSION)
  })
})
