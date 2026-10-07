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
import { Runtime } from '../../runtime/base.ts'
import { EXTERNAL_COMMANDS } from '../../runtime/constants.ts'
import { PROCESS_EXECUTOR, type ProcessExecutor } from '../../runtime/mixin.ts'
import type { RunResult } from '../../runtime/types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import {
  Consumer,
  SHELL_CONSUMERS,
  commandVisible,
  dereferences,
  execs,
  readsSubtrees,
  lookup,
  lookupAll,
  lsLinkMode,
  program,
  programNote,
  programs,
  verbVisible,
  walksMounts,
} from './index.ts'
import { SessionState } from '../session/session.ts'
import { Workspace } from '../workspace/workspace.ts'

class Sandbox extends Runtime implements ProcessExecutor {
  readonly [PROCESS_EXECUTOR] = true as const
  readonly name = 'sandbox'
  constructor() {
    super({}, ['gcc', EXTERNAL_COMMANDS])
  }
  runProcess(): Promise<RunResult> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }
}

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
    session.functions.greet = 'greet() { :; }'
    expect(lookup('greet', session, ws.registry)).toBe(Consumer.FUNCTION)
  })

  it('builtin shadows a function of the same name', () => {
    const { session, ws } = fixture()
    session.functions.echo = 'echo() { :; }'
    expect(lookup('echo', session, ws.registry)).toBe(Consumer.SESSION)
  })

  it('function shadows a mount command', () => {
    const { session, ws } = fixture()
    session.functions.cat = 'cat() { :; }'
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
    session.functions.prog = 'prog() { :; }'
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

describe('lsLinkMode', () => {
  // coreutils 9.7: the last of -L, -H and
  // --dereference-command-line-symlink-to-dir wins; without one, -d, a long
  // format or the classify style (abbreviated or valued) resolve no
  // command-line link, and anything else resolves a link to a directory. -p
  // and --file-type are not classify. Mirrors test_constants.py.
  it.each([
    [['ls', '-l', '/data/link'], 'none'],
    [['ls', '-d', '/data/link'], 'none'],
    [['ls', '-la', '/data/link'], 'none'],
    [['ls', '-g', '/data/link'], 'none'],
    [['ls', '-F', '/data/link'], 'none'],
    [['ls', '--cl', '/data/link'], 'none'],
    [['ls', '--indicator-style=classify', '/data/link'], 'none'],
    [['ls', '/data/link'], 'directory'],
    [['ls', '-p', '/data/link'], 'directory'],
    [['ls', '--file-type', '/data/link'], 'directory'],
    [['ls', '--classify=never', '/data/link'], 'directory'],
    [['ls', '-l', '-L', '/data/link'], 'all'],
    [['ls', '-F', '-H', '/data/link'], 'all'],
    [['ls', '-H', '--dereference-command-line-symlink-to-dir', '/data/link'], 'directory'],
  ] as const)('reads %j as %s', (words, mode) => {
    expect(lsLinkMode(words)).toBe(mode)
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
    session.functions.deploy = 'deploy() { :; }'
    expect(lookup('deploy', session, reg)).toBe(Consumer.FUNCTION)
    expect(commandVisible('deploy', session)).toBe(true)
    session.functions.sleep = 'sleep() { :; }'
    expect(lookup('sleep', session, reg)).toBe(Consumer.UNKNOWN)
    expect(commandVisible('sleep', session)).toBe(false)
    // A function shadowing a hidden CLI or mount command runs, and the
    // hidden layer stays out of `type -a`.
    session.functions.rm = 'rm() { :; }'
    expect(lookupAll('rm', session, reg)).toEqual([Consumer.FUNCTION])
    // No allow list at all: nothing filtered (the function still
    // shadows).
    session.commands = null
    expect(lookupAll('rm', session, reg)).toEqual([Consumer.FUNCTION, Consumer.MOUNT])
    expect(lookup('sleep', session, reg)).toBe(Consumer.SESSION)
  })
})

describe('program', () => {
  it('is what a real system ships as a file', () => {
    const { session, ws } = fixture()
    expect(program('cat', session, ws.registry)).toBe(Consumer.MOUNT)
    expect(program('readlink', session, ws.registry)).toBe(Consumer.NAMESPACE)
    // A builtin a real system also finds on disk keeps its file.
    expect(program('echo', session, ws.registry)).toBe(Consumer.SESSION)
    expect(program('xargs', session, ws.registry)).toBe(Consumer.SESSION)
    // The shell's own words, reserved words and unknowns have none.
    for (const name of ['cd', 'export', 'if', 'nope-xyz', '/bin/ls']) {
      expect(program(name, session, ws.registry)).toBeNull()
    }
  })

  it('execs finds programs, functions and paths', () => {
    const { session, ws } = fixture()
    session.functions.myfn = 'myfn() { :; }'
    session.functions.cd = 'cd() { :; }'
    for (const name of ['cat', 'echo', 'xargs', 'myfn', './run.sh', '/data/x']) {
      expect(execs(name, session, ws.registry)).toBe(true)
    }
    for (const name of ['cd', 'export', 'if', 'nope-xyz']) {
      expect(execs(name, session, ws.registry)).toBe(false)
    }
  })

  it('keeps the file under a shadowing function', () => {
    const { session, ws } = fixture()
    session.functions.cat = 'cat() { :; }'
    expect(lookup('cat', session, ws.registry)).toBe(Consumer.FUNCTION)
    expect(program('cat', session, ws.registry)).toBe(Consumer.MOUNT)
    session.functions.myfn = 'myfn() { :; }'
    expect(program('myfn', session, ws.registry)).toBeNull()
  })

  it('programs lists every program the session can run, sorted', () => {
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    const names = programs(session, ws.registry)
    expect(names).toEqual([...names].sort())
    for (const name of ['cat', 'echo', 'prog', 'readlink', 'xargs']) expect(names).toContain(name)
    for (const name of ['cd', 'export', '[[']) expect(names).not.toContain(name)
  })

  it('programs follows the allow list', () => {
    const { ws } = fixture()
    const narrow = new SessionState({
      sessionId: 'n',
      commands: { allow: ['cat'], ask: [], deny: [] },
    })
    expect(programs(narrow, ws.registry)).toEqual(['cat'])
  })

  // An interpreter is a program only where a language runtime runs it; a
  // workspace without one answers `python3: command not found`, as a system
  // that never installed it does, so neither `which` nor `ls /usr/bin` finds it.
  it('has no file for an interpreter no language runtime runs', () => {
    const ws = new Workspace(
      { '/ram': new RAMVFS() },
      { mode: MountMode.WRITE, runtimes: ['workspace'] },
    )
    const session = new SessionState({ sessionId: 't' })
    for (const name of ['python3', 'python', 'node', 'js']) {
      expect(program(name, session, ws.registry)).toBeNull()
      expect(programs(session, ws.registry)).not.toContain(name)
    }
  })

  it('keeps the file for an interpreter a language runtime runs', () => {
    const { session, ws } = fixture()
    expect(program('python3', session, ws.registry)).toBe(Consumer.SESSION)
    expect(programs(session, ws.registry)).toContain('python3')
  })

  it('has no file for a shell word a mount also registers', () => {
    const { session, ws } = fixture()
    expect(lookupAll('history', session, ws.registry)).toEqual([Consumer.SESSION, Consumer.MOUNT])
    expect(program('history', session, ws.registry)).toBeNull()
    expect(programs(session, ws.registry)).not.toContain('history')
  })

  it('is no file for a name only the fallback takes', () => {
    const session = new SessionState({ sessionId: 't' })
    const ws = new Workspace({ '/': new RAMVFS() }, { runtimes: [new Sandbox()] })
    expect(lookup('native-tool', session, ws.registry)).toBe(Consumer.EXTERNAL)
    expect(program('native-tool', session, ws.registry)).toBeNull()
    expect(program('gcc', session, ws.registry)).toBe(Consumer.EXTERNAL)
    expect(programs(session, ws.registry)).toContain('gcc')
  })
})

describe('programNote', () => {
  it('says what runs the name', () => {
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    expect(programNote('cat', session, ws.registry)).toBe(
      'cat is built into mirage. Help: cat --help',
    )
    expect(programNote('prog', session, ws.registry)).toBe(
      'prog is a CLI registered with this workspace. Help: prog --help',
    )
    expect(programNote('python3', session, ws.registry)).toBe(
      "python3 runs on the workspace's pyodide runtime.",
    )
    // A builtin's --help varies, so its line names none.
    for (const name of ['echo', 'ln', 'xargs']) {
      expect(programNote(name, session, ws.registry)).toBe(`${name} is built into mirage.`)
    }
    expect(programNote('cd', session, ws.registry)).toBeNull()
  })

  it('names the runtime a capture runs on', () => {
    const session = new SessionState({ sessionId: 't' })
    const ws = new Workspace({ '/': new RAMVFS() }, { runtimes: [new Sandbox()] })
    expect(programNote('gcc', session, ws.registry)).toBe(
      "gcc runs on the workspace's sandbox runtime.",
    )
    expect(programNote('native-tool', session, ws.registry)).toBeNull()
  })
})
