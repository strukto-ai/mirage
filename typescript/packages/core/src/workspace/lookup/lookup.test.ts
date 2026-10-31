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
import { CommandSpec } from '../../commands/spec/types.ts'
import { CLIHandler } from '../../commands/cli/types.ts'
import { command } from '../../commands/config.ts'

import { describe, expect, it, vi } from 'vitest'
import { CLI } from '../../commands/cli/types.ts'
import { IOResult } from '../../io/types.ts'
import { Runtime } from '../../runtime/base.ts'
import { EXTERNAL_COMMANDS } from '../../runtime/constants.ts'
import { PROCESS_EXECUTOR, type ProcessExecutor } from '../../runtime/mixin.ts'
import { PythonRuntime } from '../../runtime/python/base.ts'
import type { RunResult } from '../../runtime/types.ts'
import { headAllowed } from '../../policy/match/allow.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Follow, LineFacts, MountMode, PathSpec, wordText } from '../../types.ts'
import { ParsedArgs } from '../../commands/spec/parser.ts'
import { SPECS, parseCommand } from '../../commands/spec/index.ts'
import { PARSES_KEPT } from '../../commands/spec/constants.ts'
import * as stream from '../../rs/stream.ts'
import { SCANS } from '../../rs/scan.ts'
import { declaredCalls, methodName } from '../../vfs/call.ts'
import { Effect } from '../../vfs/types.ts'
import {
  Consumer,
  SHELL_CONSUMERS,
  execs,
  lineFacts,
  lookup,
  lookupAll,
  program,
  programNote,
  programs,
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

class HostPython extends PythonRuntime implements ProcessExecutor {
  readonly [PROCESS_EXECUTOR] = true as const
  readonly name = 'host-python'
  interpret(): Promise<RunResult> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }
  runProcess(): Promise<RunResult> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }
}

function fixture(): { session: SessionState; ws: Workspace } {
  const ram = new RAMVFS()
  const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE })
  return { session: new SessionState({ sessionId: 't' }), ws }
}

function noopVerb(): [null, IOResult] {
  return [null, new IOResult()]
}

function cliTree(): CLI {
  return new CLI({
    spec: new CommandSpec({ name: 'prog', subcommands: [new CommandSpec({ name: 'run' })] }),
    handlers: { run: new CLIHandler({ fn: noopVerb }) },
  })
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

  it('an unregistered CLI routes UNKNOWN', async () => {
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    await ws.unregisterCli('prog')
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

const follows = (words: readonly (string | PathSpec)[]): Follow =>
  lineFacts(wordText(words[0] ?? ''), words, '/').follows

describe('lineFacts follows', () => {
  // coreutils 9.7, file 5.46, findutils 4.10: lstat by default for these,
  // the later of -L and its take-back (-h, -P) deciding, and find's -P/-H/-L
  // only before the first start point. Mirrors test_constants.py.
  it.each([
    [['stat', '/data/link'], Follow.NONE],
    [['stat', '-L', '/data/link'], Follow.LAST],
    [['stat', '-Lc', '%n', '/data/link'], Follow.LAST],
    [['stat', '--dereference', '/data/link'], Follow.LAST],
    [['stat', '--deref', '/data/link'], Follow.LAST],
    [['stat', '-c', '%L', '/data/link'], Follow.NONE],
    [['stat', '--', '-L'], Follow.NONE],
    [['rm', '-L', '/data/link'], Follow.NONE],
    [['cat', '-l', '/data/link'], Follow.LAST],
    [['file', '/data/link'], Follow.NONE],
    [['file', '-L', '/data/link'], Follow.LAST],
    [['file', '-h', '/data/link'], Follow.NONE],
    [['file', '-L', '-h', '/data/link'], Follow.NONE],
    [['file', '-h', '-L', '/data/link'], Follow.LAST],
    [['file', '-Lh', '/data/link'], Follow.NONE],
    [['du', '/data/link'], Follow.NONE],
    [['du', '-L', '/data/link'], Follow.LAST],
    [['du', '-LP', '/data/link'], Follow.NONE],
    [['du', '-PL', '/data/link'], Follow.LAST],
    [['du', '-L', '-P', '/data/link'], Follow.NONE],
    [['find', '/data/link'], Follow.NONE],
    [['find', '-H', '/data/link'], Follow.LAST],
    [['find', '-L', '-P', '/data/link'], Follow.NONE],
    [['find', '-P', '-L', '/data/link'], Follow.LAST],
    [['find', '-L', '-P', '-L', '/data/link'], Follow.LAST],
    [['find', '/data/link', '-L'], Follow.NONE],
    [['tar', '-chf', '/out.tar', '/data/link'], Follow.NONE],
    [['zip', '-r', '/out.zip', '/data/link'], Follow.NONE],
    [['mv', '/data/link', '/x'], Follow.NONE],
    [['rmdir', '/data/link'], Follow.NONE],
    [['unlink', '/data/link'], Follow.NONE],
    [['mkdir', '-p', '/data/link'], Follow.NONE],
    [['touch', '/data/link'], Follow.NONE],
    [['ln', '-s', '/x', '/data/link'], Follow.NONE],
    [['readlink', '/data/link'], Follow.NONE],
  ] as const)('reads %j as %s', (words, follow) => {
    expect(follows(words)).toBe(follow)
  })

  it('does not read a PathSpec operand as a flag', () => {
    // Operands arrive classified as PathSpec, not string.
    const spec = PathSpec.fromStrPath('/data/-L')
    expect(follows(['stat', spec])).toBe(Follow.NONE)
  })

  // coreutils 9.7: the last of -L, -H and
  // --dereference-command-line-symlink-to-dir wins; without one, -d, a long
  // format or the classify style (abbreviated or valued) resolve no
  // command-line link, and anything else resolves a link to a directory. -p
  // and --file-type are not classify. Mirrors test_constants.py.
  it.each([
    [['ls', '-l', '/data/link'], Follow.NONE],
    [['ls', '-d', '/data/link'], Follow.NONE],
    [['ls', '-la', '/data/link'], Follow.NONE],
    [['ls', '-g', '/data/link'], Follow.NONE],
    [['ls', '-F', '/data/link'], Follow.NONE],
    [['ls', '--cl', '/data/link'], Follow.NONE],
    [['ls', '--indicator-style=classify', '/data/link'], Follow.NONE],
    [['ls', '/data/link'], Follow.DIRECTORY],
    [['ls', '-p', '/data/link'], Follow.DIRECTORY],
    [['ls', '--file-type', '/data/link'], Follow.DIRECTORY],
    [['ls', '--classify=never', '/data/link'], Follow.DIRECTORY],
    [['ls', '-l', '-L', '/data/link'], Follow.LAST],
    [['ls', '-F', '-H', '/data/link'], Follow.LAST],
    [['ls', '-H', '--dereference-command-line-symlink-to-dir', '/data/link'], Follow.DIRECTORY],
  ] as const)('reads ls %j as %s', (words, follow) => {
    expect(follows(words)).toBe(follow)
  })
})

describe('walkers and subtree readers', () => {
  // grep 3.11, coreutils 9.7: a long option's prefix, -d recurse and an
  // option's attached value read as grep reads them, the last of -r and -d
  // wins, and a -d word grep refuses walks nothing. Mirrors
  // test_constants.py.
  it.each([
    [['find', '/data'], true],
    [['du', '/data'], true],
    [['du', '-x', '/data'], false],
    [['tree'], true],
    [['tree', '-x', '/data'], false],
    [['rg', 'x'], true],
    [['rg', '--one-file-system', 'x', '/data'], false],
    [['rg', '--type-list'], false],
    [['grep', 'x', '/data'], false],
    [['grep', '-rn', 'x', '/data'], true],
    [['grep', '--recursive', 'x'], true],
    [['grep', '--recur', 'x', '/data'], true],
    [['grep', '-d', 'recurse', 'x', '/data'], true],
    [['grep', '--directories=recurse', 'x', '/data'], true],
    [['grep', '--dereference-recursive', 'x', '/data'], true],
    [['grep', '-r', '-d', 'skip', 'x', '/data'], false],
    [['grep', '-d', 'bogus', 'x', '/data'], false],
    [['grep', '-ephrase', '/data/x'], false],
    [['grep', '-frules.txt', '/data/x'], false],
    [['grep', '--', '-r'], false],
    [['egrep', '-r', 'x'], true],
    [['fgrep', 'x', '/data'], false],
    [['ls', '-R', '/data'], true],
    [['ls', '--recur', '/data'], true],
    [['ls', '-l', '/data'], false],
    [['cat', '/data/x'], false],
    [['tar', '-cf', '/out.tar', '/data'], false],
  ] as const)('reads %j as walking: %s', (words, walking) => {
    expect(lineFacts(words[0], words, '/').walks).toBe(walking)
  })

  // tar -c (dashless too), zip -r and cp -r or -a read below their operands
  // but stop at a mount boundary, so they read subtrees without walking
  // mounts; a walk kept to one mount still reads its subtree.
  it.each([
    [['tar', '-cf', '/out.tar', '/data'], true],
    [['tar', 'cf', '/out.tar', '/data'], true],
    [['tar', '--create', '-f', '/out.tar', '/data'], true],
    [['tar', '-xf', '/out.tar'], false],
    [['zip', '-r', '/out.zip', '/data'], true],
    [['zip', '/out.zip', '/data/a'], false],
    [['cp', '-r', '/data', '/copy'], true],
    [['cp', '-a', '/data', '/copy'], true],
    [['cp', '--archive', '/data', '/copy'], true],
    [['cp', '--recur', '/data', '/copy'], true],
    [['cp', '/data/a', '/copy'], false],
    [['grep', '-r', 'x', '/data'], true],
    [['du', '-x', '/data'], true],
    [['tree', '-x', '/data'], true],
    [['rg', '--one-file-system', 'x', '/data'], true],
    [['find', '/data'], true],
    [['ls', '-l', '/data'], false],
  ] as const)('reads %j as reading below: %s', (words, reads) => {
    expect(lineFacts(words[0], words, '/').readsSubtree).toBe(reads)
  })
})

describe('lineFacts writes', () => {
  // sed 4.9 opens a w file while it reads the script, before it refuses a
  // later command. Mirrors test_constants.py.
  it.each([
    [['sort', '/data/a'], false],
    [['sort', '-o', '/data/b', '/data/a'], true],
    [['sort', '--out=/data/b', '/data/a'], true],
    [['shuf', '/data/a'], false],
    [['shuf', '-o', '/data/b', '/data/a'], true],
    [['iconv', '-f', 'utf-8', '/data/a'], false],
    [['iconv', '-o', '/data/b', '/data/a'], true],
    [['uniq', '/data/a'], false],
    [['uniq', '/data/a', '/data/b'], true],
    [['xxd', '/data/a'], false],
    [['xxd', '-r', '/data/a', '/data/b'], true],
    [['tee'], false],
    [['tee', '/data/a'], true],
    [['mktemp', '-u'], false],
    [['mktemp'], true],
    [['tar', '-tf', '/data/a.tar'], false],
    [['tar', '-xOf', '/data/a.tar'], false],
    [['tar', '-xf', '/data/a.tar'], true],
    [['tar', 'cf', '/data/a.tar', '/data/d'], true],
    [['unzip', '-l', '/data/a.zip'], false],
    [['unzip', '-p', '/data/a.zip'], false],
    [['unzip', '/data/a.zip'], true],
    [['gzip'], false],
    [['gzip', '-c', '/data/a'], false],
    [['gzip', '/data/a'], true],
    [['gunzip', '-t', '/data/a.gz'], false],
    [['gunzip', '/data/a.gz'], true],
    [['sed', '-n', 'p', '/data/a'], false],
    [['sed', '-i', 's/a/b/', '/data/a'], true],
    [['sed', 'w /data/out', '/data/a'], true],
    [['sed', '-e', 's/a/b/w /data/out', '/data/a'], true],
    [['sed', '-f', '/data/script', '/data/a'], true],
    [['sed', 'w /data/out\\nq q', '/data/a'], true],
    [['awk', '1', '/data/a'], true],
    [['cp', '/data/a', '/data/b'], true],
  ] as const)('reads %j as writing: %s', (words, writes) => {
    expect(lineFacts(words[0], words, '/').writes).toBe(writes)
  })

  it('keeps a bounded number of facts on one parse', () => {
    const names = Array.from({ length: 6 }, (_, i) => `/data/p${i}*`)
    for (let mask = 0; mask < 1 << names.length; mask++) {
      const operands = names.map((n, i) => {
        const quoted = (mask & (1 << i)) !== 0
        const base = n.slice('/data/'.length)
        return new PathSpec({
          virtual: n,
          directory: '/data',
          vfsPath: base,
          pattern: quoted ? null : base,
          resolved: quoted,
        })
      })
      lineFacts('sort', ['sort', ...operands], '/')
    }
    const parsed = parseCommand(SPECS.sort!, names, '/', 'sort')
    expect(parsed.facts.size).toBeGreaterThan(0)
    expect(parsed.facts.size).toBeLessThanOrEqual(PARSES_KEPT)
  })

  it.each(['uniq', 'xxd'])('%s reads a pattern operand as a possible output', (name) => {
    // The backend expands a pattern after admission, so `uniq /data/p.*` may
    // hand it an input and an output; a quoted name is no pattern.
    const pattern = new PathSpec({
      virtual: '/data/p.*',
      directory: '/data',
      vfsPath: 'p.*',
      pattern: 'p.*',
      resolved: false,
    })
    const literal = new PathSpec({ virtual: '/data/p[1]', directory: '/data', vfsPath: 'p[1]' })
    expect(lineFacts(name, [name, pattern], '/').writes).toBe(true)
    expect(lineFacts(name, [name, literal], '/').writes).toBe(false)
  })
})

describe('lineFacts subtree and move target', () => {
  it.each([
    [['rm', '-r', '/data/d'], true],
    [['rmdir', '/data/d'], true],
    [['mv', '/data/d', '/data/e'], true],
    [['cp', '-r', '/data/d', '/data/e'], false],
    [['unlink', '/data/f'], false],
  ] as const)('reads %j as taking whole subtrees: %s', (words, subtree) => {
    expect(lineFacts(words[0], words, '/').subtree).toBe(subtree)
  })

  it.each([
    [['mv', '-t', 'sub', '/data/a'], '/home', '/home/sub'],
    [['mv', '--target-directory=/out', '/data/a'], '/', '/out'],
    [['mv', '-S.txt', '/data/a', '/data/b'], '/', null],
    [['cp', '-t', '/out', '/data/a'], '/', '/out'],
    [['mv', '/data/a', '/data/b'], '/', null],
  ] as const)('resolves the target directory of %j in %s as %s', (words, cwd, target) => {
    expect(lineFacts(words[0], words, cwd).moveTarget).toBe(target)
  })
})

interface Op {
  mount: string
  name: string
  effect: Effect
  path: string
}

type Method = (this: RAMVFS, ...args: unknown[]) => unknown

function recording(mount: string, ops: Op[]): RAMVFS {
  class RecordingRAMVFS extends RAMVFS {}
  const own = new Set(Object.getOwnPropertyNames(RAMVFS.prototype))
  for (const [name, mark] of declaredCalls(RAMVFS)) {
    const method = methodName(name)
    if (!own.has(method)) continue
    const base = Object.getOwnPropertyDescriptor(RAMVFS.prototype, method)?.value as Method
    const call = Object.assign(function (this: RAMVFS, ...args: unknown[]): unknown {
      for (const arg of args) {
        if (arg instanceof PathSpec)
          ops.push({ mount, name, effect: mark.effect, path: arg.virtual })
      }
      return base.apply(this, args)
    }, base)
    Object.defineProperty(call, 'name', { value: base.name })
    Object.defineProperty(RecordingRAMVFS.prototype, method, {
      value: call,
      writable: true,
      configurable: true,
    })
  }
  return new RecordingRAMVFS()
}

const READS: ReadonlySet<Effect> = new Set([Effect.READ, Effect.METADATA])

// Commands that stat a link's target without following the link: file names
// a link whose target is gone "broken", and du asks whether its operand is
// there at all before it measures the link itself.
const PROBES_TARGET: ReadonlySet<string> = new Set(['file', 'du'])

async function effects(line: string): Promise<Op[]> {
  const ops: Op[] = []
  const ws = new Workspace(
    {
      '/': recording('/', ops),
      '/data/inner': recording('/data/inner', ops),
      '/far': recording('/far', ops),
    },
    { mode: MountMode.WRITE },
  )
  ws.createSession('s')
  try {
    for (const setup of [
      'mkdir -p /data/sub /out',
      'echo a > /data/a.txt',
      'echo b > /data/sub/b.txt',
      'echo c > /data/inner/c.txt',
      'echo t > /far/t.txt',
      'ln -s /far/t.txt /data/link',
    ]) {
      await ws.shell(setup, { sessionId: 's' })
    }
    ops.length = 0
    await ws.shell(line, { sessionId: 's' })
    return [...ops]
  } finally {
    await ws.close()
  }
}

// Lines whose declared facts the fact-vs-effect check runs against a
// recording mount. /data/inner is a descendant mount and /data/link points
// into /far, so an op on /data/inner other than a stat of its root is a walk
// and an op on /far is a follow.
const LINES = [
  'stat /data/link',
  'stat -L /data/link',
  'file /data/link',
  'file -L /data/link',
  'file -L -h /data/link',
  'du /data/link',
  'du -L /data/link',
  'du /data',
  'du -x /data',
  'find /data',
  'find /data/link',
  'find -L /data/link',
  'find /data/link -L',
  'tree /data',
  'tree -x /data',
  'grep a /data/a.txt',
  'grep -r a /data',
  'rg a /data',
  'rg --one-file-system a /data',
  'ls /data',
  'ls -R /data',
  'ls -l /data/link',
  'ls -L /data/link',
  'cat /data/link',
  'cp -r /data/sub /out',
  'tar -cf /out/x.tar /data/link',
  'zip /out/x.zip /data/link',
  'rm /data/link',
  'sort /data/a.txt',
  'shuf /data/a.txt',
  'iconv -f utf-8 -t utf-8 /data/a.txt',
  'uniq /data/a.txt',
  'xxd /data/a.txt',
  'tee',
  'mktemp -u',
  'gzip -c /data/a.txt',
  'sed -n p /data/a.txt',
  'sed -i s/a/b/ /data/a.txt',
  'mv /data/link /out/l',
  'unlink /data/link',
]

describe('line facts against effects', () => {
  it.each(LINES)('%s does no more to the mounts than its facts say', async (line) => {
    const words = line.split(' ')
    const facts = lineFacts(words[0] ?? '', words, '/')
    const ops = await effects(line)
    if (!facts.writes) {
      expect(ops.filter((op) => !READS.has(op.effect))).toEqual([])
    }
    if (!facts.walks) {
      expect(
        ops.filter(
          (op) => op.mount === '/data/inner' && !(op.name === 'stat' && op.path === '/data/inner'),
        ),
      ).toEqual([])
    }
    if (facts.follows === Follow.NONE) {
      const probes = PROBES_TARGET.has(words[0] ?? '') ? Effect.METADATA : null
      expect(ops.filter((op) => op.mount === '/far' && op.effect !== probes)).toEqual([])
    }
  })

  it.each([
    ['stat -L /data/link', '/far'],
    ['find -L /data/link', '/far'],
    ['du /data', '/data/inner'],
    ['grep -r c /data', '/data/inner'],
  ])('the recording sees %s reach %s', async (line, mount) => {
    expect((await effects(line)).some((op) => op.mount === mount)).toBe(true)
  })
})

describe('allow lists', () => {
  it('do not narrow lookup', () => {
    // The allow list is a policy: a word it leaves out is still found in
    // its layer, and the gate refuses it when it runs.
    const { session, ws } = fixture()
    ws.registerCli('prog', cliTree())
    session.commands = { allow: ['cat'], ask: [], deny: [] }
    const reg = ws.registry
    expect(lookup('cat', session, reg)).toBe(Consumer.MOUNT)
    expect(lookup('prog', session, reg)).toBe(Consumer.CLI)
    expect(lookup('ln', session, reg)).toBe(Consumer.NAMESPACE)
    expect(lookup('rm', session, reg)).toBe(Consumer.MOUNT)
    expect(lookup('cd', session, reg)).toBe(Consumer.SESSION)
    // A function shadows a command as it does with no list.
    session.functions.rm = 'rm() { :; }'
    expect(lookupAll('rm', session, reg)).toEqual([Consumer.FUNCTION, Consumer.MOUNT])
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

  it('programs lists every program whatever the allow list', () => {
    const { session, ws } = fixture()
    const narrow = new SessionState({
      sessionId: 'n',
      commands: { allow: ['cat'], ask: [], deny: [] },
    })
    expect(programs(narrow, ws.registry)).toEqual(programs(session, ws.registry))
  })

  // Debian's egrep is `exec grep -E "$@"`, so it is a program wherever grep is
  // one, and an allow list naming only grep refuses it when it runs.
  it('makes a wrapper a program where what it runs is', () => {
    const { session, ws } = fixture()
    for (const name of ['egrep', 'fgrep', 'zegrep', 'zfgrep']) {
      expect(lookup(name, session, ws.registry)).toBe(Consumer.MOUNT)
      expect(programs(session, ws.registry)).toContain(name)
    }
    expect(programNote('egrep', session, ws.registry)).toBe(
      'egrep is built into mirage. Help: egrep --help',
    )
    const narrow = new SessionState({
      sessionId: 'n',
      commands: { allow: ['grep'], ask: [], deny: [] },
    })
    expect(lookup('egrep', narrow, ws.registry)).toBe(Consumer.MOUNT)
    expect(headAllowed('egrep', narrow.commands)).toBe(false)
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
    ws.mount('/ram').registerCommands(
      command({ name: 'history', vfs: 'ram', spec: new CommandSpec(), fn: noopVerb }),
    )
    expect(lookupAll('history', session, ws.registry)).toEqual([Consumer.SESSION, Consumer.MOUNT])
    expect(program('history', session, ws.registry)).toBeNull()
    expect(programs(session, ws.registry)).not.toContain('history')
  })

  it('keeps its own names on a language runtime that runs processes', () => {
    const session = new SessionState({ sessionId: 't' })
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { runtimes: [new HostPython({ captures: ['python3', 'gcc'] })] },
    )
    expect(lookup('python3', session, ws.registry)).toBe(Consumer.SESSION)
    expect(lookup('gcc', session, ws.registry)).toBe(Consumer.EXTERNAL)
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
      "python3 runs on the workspace's monty runtime.",
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

const MAP_SET = Object.getOwnPropertyDescriptor(Map.prototype, 'set')?.value as (
  key: unknown,
  value: unknown,
) => Map<unknown, unknown>

interface Reads {
  parses: number
  scans: Map<string, number>
  facts: number
}

// What one run of a line reads afresh: each parse and each LineFacts a
// reading keeps is stored once as it is made, and each scan opens a stream.
async function reads(ws: Workspace, line: string): Promise<Reads> {
  const counted: Reads = { parses: 0, scans: new Map(), facts: 0 }
  const set = MAP_SET
  const kept = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown,
  ) {
    if (value instanceof ParsedArgs) counted.parses++
    if (value instanceof LineFacts) counted.facts++
    return Reflect.apply(set, this, [key, value])
  })
  const open = stream.openStreamSync
  const opened = vi.spyOn(stream, 'openStreamSync').mockImplementation((kind, config, movable) => {
    if (kind === 'scan') {
      const tape = JSON.stringify([config.command, config.options])
      counted.scans.set(tape, (counted.scans.get(tape) ?? 0) + 1)
    }
    return open(kind, config, movable)
  })
  try {
    await ws.shell(line, { sessionId: 's' })
  } finally {
    kept.mockRestore()
    opened.mockRestore()
  }
  return counted
}

async function workspace(): Promise<Workspace> {
  const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
  ws.createSession('s')
  for (const setup of [
    'mkdir -p /data/sub /out',
    'echo a > /data/a.txt',
    'echo b > /data/sub/b.txt',
  ])
    await ws.shell(setup, { sessionId: 's' })
  return ws
}

describe('reading a line once', () => {
  // Each line's words are its own, so no earlier test's facts are still kept
  // for it; another line may have parsed a word list it shares. Both gates,
  // routing and the handler read one line: its facts are worked out once,
  // each spec parses its words once, and each tape mirage-rs scans is
  // scanned once, the -d grep's gate reads among them. Run again, the line
  // reads all of it from what was kept.
  it.each([
    ['grep -r q1 /data', 2, '["grep",[["recursive",""]]]'],
    ['grep -d recurse q2 /data', 2, '["grep",[["directories","recurse"]]]'],
    ['grep -d skip q3 /data/a.txt', 2, '["grep",[["directories","skip"]]]'],
    ['sort -o /out/q4 /data/a.txt', 2, '["sort",[["output","/out/q4"],["","/data/a.txt"]]]'],
    ['find /data -name q5', 4, null],
    ['sed -n /q6/p /data/a.txt', 2, null],
    ['ls -R /data/sub/q7', 2, null],
  ] as const)('%s reads its facts once and scans each tape once', async (line, parses, tape) => {
    SCANS.clear()
    const ws = await workspace()
    let first: Reads
    let again: Reads
    try {
      first = await reads(ws, line)
      again = await reads(ws, line)
    } finally {
      await ws.close()
    }
    expect(first.facts).toBe(1)
    expect(first.parses).toBeLessThanOrEqual(parses)
    expect(new Set(first.scans.values())).toEqual(first.scans.size > 0 ? new Set([1]) : new Set())
    if (tape !== null) expect(first.scans.get(tape)).toBe(1)
    expect(again).toEqual({ parses: 0, scans: new Map(), facts: 0 })
  })

  // A walk over a nested mount asks again whether the line walks; it reads
  // the facts the gate kept, so the command's facts run once. Each line's
  // words are its own, so no earlier test kept its facts.
  it.each([
    'grep -r q11 /data',
    'find /data -name q12',
    'du -L /data /data/inner/q13',
    'ls -R /data /data/inner/q14',
  ])('%s over a nested mount reads its facts once', async (line) => {
    const ws = new Workspace(
      { '/': new RAMVFS(), '/data/inner': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    ws.createSession('s')
    let made = 0
    const freeze = Object.freeze
    const spy = vi.spyOn(Object, 'freeze').mockImplementation((value: unknown) => {
      if (value instanceof LineFacts) made++
      return freeze(value)
    })
    try {
      await ws.shell('echo a > /data/inner/a.txt', { sessionId: 's' })
      made = 0
      await ws.shell(line, { sessionId: 's' })
    } finally {
      spy.mockRestore()
      await ws.close()
    }
    expect(made).toBe(1)
  })

  it('no reader of a line changes the parse it shares', async () => {
    const kept: [ParsedArgs, unknown][] = []
    const set = MAP_SET
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (value instanceof ParsedArgs) kept.push([value, structuredClone(value)])
      return Reflect.apply(set, this, [key, value])
    })
    const ws = await workspace()
    try {
      for (const line of [
        'grep -d recurse -m 1 q8 /data',
        'sort -o /out/q9 /data/a.txt',
        'find -L /data -name q10',
        'mv -t /out /data/sub',
      ]) {
        for (let round = 0; round < 2; round++) await ws.shell(line, { sessionId: 's' })
      }
    } finally {
      spy.mockRestore()
      await ws.close()
    }
    expect(kept.length).toBeGreaterThan(0)
    for (const [parsed, then] of kept) expect(parsed).toEqual(then)
  })

  it('two readers of a line share one frozen reading', () => {
    const words = ['sort', '-o', '/out/q11', '/data/a.txt']
    const facts = lineFacts('sort', words, '/')
    expect(lineFacts('sort', [...words], '/')).toBe(facts)
    expect(() => {
      ;(facts as { writes: boolean }).writes = false
    }).toThrow(TypeError)
  })
})
