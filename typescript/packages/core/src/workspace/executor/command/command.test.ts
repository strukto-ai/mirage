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
import { EvaluationContext } from '../../evaluation.ts'
import { describe, expect, it } from 'vitest'
import { command } from '../../../commands/config.ts'
import { CLI, CLIHandler } from '../../../commands/cli/types.ts'
import { CommandSpec, type FlagValue, Argument } from '../../../commands/spec/types.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { parseSessionProfile } from '../../../policy/profile.ts'
import { JobTable } from '../../../shell/job_table/index.ts'
import { BaseVFS } from '../../../vfs/base.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { MountRegistry } from '../../mount/registry.ts'
import { SessionState } from '../../session/session.ts'
import type { ExecuteNodeFn } from './types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { WorkspaceRuntime } from '../../../runtime/workspace.ts'
import { handleCommand } from './command.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace.ts'

function treeFallbackRegistry(): MountRegistry {
  const registry = new MountRegistry(
    { '/longer': new RAMVFS(), '/short': new RAMVFS() },
    MountMode.WRITE,
  )
  for (const prefix of ['/longer', '/short']) {
    const answer = (): [Uint8Array, IOResult] => [
      new TextEncoder().encode(`${prefix}\n`),
      new IOResult(),
    ]
    registry.mountForPrefix(prefix).registerCommands([
      new CLI({
        spec: new CommandSpec({
          name: 'remote',
          subcommands: [new CommandSpec({ name: 'get' }), new CommandSpec({ name: 'put' })],
        }),
        handlers: {
          get: new CLIHandler({ fn: answer }),
          put: new CLIHandler({ fn: answer, write: true }),
        },
      }),
    ])
  }
  return registry
}

describe('handleCommand — mount tree fallback', () => {
  it.each([false, true])(
    'keeps tree verbs and group values distinct from a flat path grammar (writes=%s)',
    async (write) => {
      const ws = new Workspace(
        { '/longer': new RAMVFS(), '/b': new RAMVFS() },
        {
          mode: MountMode.WRITE,
        },
      )
      const calls: string[] = []
      try {
        ws.mount('/longer').registerCommands(
          command({
            name: 'tool',
            vfs: 'ram',
            write,
            spec: new CommandSpec({
              arguments: [new Argument('paths', { type: 'path', nargs: '*' })],
            }),
            fn: () => {
              calls.push('flat')
              return [new TextEncoder().encode('flat\n'), new IOResult()]
            },
          }),
        )
        ws.mount('/b').registerCommands([
          new CLI({
            spec: new CommandSpec({
              name: 'tool',
              arguments: [new Argument('--account')],
              subcommands: [new CommandSpec({ name: 'send' })],
            }),
            handlers: {
              send: new CLIHandler({
                write: true,
                fn: () => {
                  calls.push('tree')
                  return [new TextEncoder().encode('tree\n'), new IOResult()]
                },
              }),
            },
          }),
        ])
        const ambiguity =
          'tool: ambiguous, registered on 2 writable mounts:\n  /longer\n  /b\ncd into the target mount to disambiguate.\n'
        for (const [line, output, unbound] of [
          ['tool send', 'tree\n', true],
          ['tool --account /longer send', 'tree\n', true],
          ['tool /longer/item', 'flat\n', false],
          ['cd /longer && tool send', 'flat\n', false],
        ] as const) {
          const refused = write && unbound
          const before = calls.length
          const result = await ws.shell(line)
          expect([result.exitCode, result.stdoutText, result.stderrText], line).toEqual([
            refused ? 1 : 0,
            refused ? '' : output,
            refused ? ambiguity : '',
          ])
          if (refused) expect(calls).toHaveLength(before)
        }
      } finally {
        await ws.close()
      }
    },
  )

  it.each([false, true])(
    'selects a later tree that recognizes the verb (writes=%s)',
    async (write) => {
      const registry = treeFallbackRegistry()
      for (const [prefix, verb] of [
        ['/longer', 'peek'],
        ['/short', 'send'],
      ] as const) {
        registry.mountForPrefix(prefix).registerCommands([
          new CLI({
            spec: new CommandSpec({
              name: 'remote',
              subcommands: [new CommandSpec({ name: verb })],
            }),
            handlers: {
              [verb]: new CLIHandler({
                write,
                fn: () => [new TextEncoder().encode(`${prefix}\n`), new IOResult()],
              }),
            },
          }),
        ])
      }
      const [stdout, io] = await handleCommand(
        NEVER_EXECUTE,
        NEVER_DISPATCH,
        registry,
        ['remote', 'send'],
        routed(new EvaluationContext(new SessionState({ sessionId: 'test' }))),
      )
      expect(io.exitCode).toBe(0)
      expect(decode(await materialize(stdout))).toBe('/short\n')
    },
  )
  it.each(['str', 'path'] as const)(
    'runs a selected tree when discovery found a flat %s reader first',
    async (type) => {
      const registry = treeFallbackRegistry()
      registry.mount('/', new RAMVFS(), MountMode.WRITE)
      registry.mountForPrefix('/longer').registerCommands(
        command({
          name: 'remote',
          vfs: 'ram',
          spec: new CommandSpec({ arguments: [new Argument('args', { type, nargs: '*' })] }),
          fn: () => [null, new IOResult()],
        }),
      )
      const [stdout, io] = await handleCommand(
        NEVER_EXECUTE,
        NEVER_DISPATCH,
        registry,
        ['remote', 'put'],
        routed(new EvaluationContext(new SessionState({ sessionId: 'test' }))),
      )
      expect(io.exitCode).toBe(0)
      expect(decode(await materialize(stdout))).toBe('/short\n')
    },
  )

  it.each([
    ['get', '/longer/'],
    ['put', '/short/'],
  ])('routes the %s leaf by its own write declaration', async (verb, prefix) => {
    const registry = treeFallbackRegistry()
    registry.mountForPrefix('/longer').mode = MountMode.READ
    const [stdout, io] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      registry,
      ['remote', verb],
      routed(new EvaluationContext(new SessionState({ sessionId: 'test' }))),
    )
    expect(io.exitCode).toBe(0)
    expect(decode(await materialize(stdout))).toBe(`${prefix.slice(0, -1)}\n`)
  })

  it.each([['--help'], ['put', '--help'], ['put', '-h'], ['unknown']])(
    'answers tree help or usage before ambiguous write selection: %s',
    async (...argv) => {
      const registry = treeFallbackRegistry()
      const [stdout, io] = await handleCommand(
        NEVER_EXECUTE,
        NEVER_DISPATCH,
        registry,
        ['remote', ...argv],
        routed(new EvaluationContext(new SessionState({ sessionId: 'test' }))),
      )
      expect(decode(io.stderr as Uint8Array)).not.toContain('ambiguous')
      expect(decode(await materialize(stdout)) + decode(io.stderr as Uint8Array)).toContain(
        argv[0] === 'unknown' ? "'unknown' is not a remote command" : 'usage:',
      )
    },
  )

  it('refuses two writable trees and keeps cwd selection authoritative', async () => {
    const registry = treeFallbackRegistry()
    const session = new SessionState({ sessionId: 'test' })
    const [, refused] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      registry,
      ['remote', 'put'],
      routed(new EvaluationContext(session)),
    )
    expect(refused.exitCode).toBe(1)
    expect(decode(refused.stderr as Uint8Array)).toBe(
      'remote: ambiguous, registered on 2 writable mounts:\n' +
        '  /longer\n  /short\ncd into the target mount to disambiguate.\n',
    )
    session.cwd = '/short'
    const [stdout, io] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      registry,
      ['remote', 'put'],
      routed(new EvaluationContext(session)),
    )
    expect(io.exitCode).toBe(0)
    expect(decode(await materialize(stdout))).toBe('/short\n')
  })
})

class StubVFS extends BaseVFS {
  constructor(override readonly name: string) {
    super()
  }
  override close(): Promise<void> {
    return Promise.resolve()
  }
}

// An evaluation on the decision a line no policy placed, on a world of
// the workspace alone.
function routed(context: EvaluationContext): EvaluationContext {
  context.frame.routing = { bindings: {}, fallback: new WorkspaceRuntime() }
  return context
}

const NEVER_EXECUTE: ExecuteNodeFn = () => {
  throw new Error('executeNode should not have been called')
}

const NEVER_DISPATCH: DispatchFn = () => {
  throw new Error('dispatch should not have been called')
}

function decode(b: Uint8Array | null): string {
  if (b === null) return ''
  return new TextDecoder().decode(b)
}

describe('handleCommand — command not found', () => {
  it('returns exit 127 when no mount has the command', async () => {
    const reg = new MountRegistry({ '/ram': new StubVFS('ram') }, MountMode.WRITE)
    const [, io, exec] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['nope'],
      new EvaluationContext(new SessionState({ sessionId: 'test' })),
    )
    expect(io.exitCode).toBe(127)
    expect(exec.exitCode).toBe(127)
    expect(decode(io.stderr as Uint8Array)).toMatch(/command not found/)
  })
})

describe('handleCommand — dispatches to mount that has the command', () => {
  const BASIC_SPEC = new CommandSpec({
    arguments: [new Argument('paths', { metavar: '', type: 'path', nargs: '*' })],
  })

  it('routes to a mount whose VFS registered the command', async () => {
    const ram = new StubVFS('ram')
    const reg = new MountRegistry({ '/ram': ram }, MountMode.WRITE)
    const mount = reg.mountFor('/ram/x')
    const [cmd] = command({
      name: 'cat',
      vfs: 'ram',
      spec: BASIC_SPEC,
      fn: () => [new TextEncoder().encode('hello'), new IOResult()],
    })
    if (cmd === undefined) throw new Error('cmd missing')
    mount.register(cmd)

    const [stdout, io, exec] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['cat', PathSpec.fromStrPath('/ram/x')],
      routed(new EvaluationContext(new SessionState({ sessionId: 'test' }))),
    )
    expect(io.exitCode).toBe(0)
    expect(exec.exitCode).toBe(0)
    expect(decode(await materialize(stdout))).toBe('hello')
  })

  it('parses flags through the spec and forwards them', async () => {
    const ram = new StubVFS('ram')
    const reg = new MountRegistry({ '/ram': ram }, MountMode.WRITE)
    const mount = reg.mountFor('/ram')
    const spec = new CommandSpec({
      arguments: [
        new Argument('-n'),
        new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
      ],
    })
    let seenFlags: Record<string, FlagValue> = {}
    const [cmd] = command({
      name: 'head',
      vfs: 'ram',
      spec,
      fn: (_accessor, _paths, _texts, opts) => {
        seenFlags = opts.flags
        return [null, new IOResult()]
      },
    })
    if (cmd === undefined) throw new Error('cmd missing')
    mount.register(cmd)

    await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['head', '-n', '5', PathSpec.fromStrPath('/ram/x')],
      routed(new EvaluationContext(new SessionState({ sessionId: 'test' }))),
    )
    expect(seenFlags.n).toBe('5')
  })
})

describe('handleCommand — cross-mount', () => {
  it('rejects multi-mount paths when cmd is not cross-capable', async () => {
    const reg = new MountRegistry(
      { '/ram': new StubVFS('ram'), '/disk': new StubVFS('disk') },
      MountMode.WRITE,
    )
    const mount = reg.mountFor('/ram')
    const [cmd] = command({
      name: 'mycmd',
      vfs: 'ram',
      spec: new CommandSpec({
        arguments: [new Argument('paths', { metavar: '', type: 'path', nargs: '*' })],
      }),
      fn: () => [null, new IOResult()],
    })
    if (cmd === undefined) throw new Error('cmd missing')
    mount.register(cmd)
    const [, io, exec] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['mycmd', PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')],
      new EvaluationContext(new SessionState({ sessionId: 'test' })),
    )
    expect(io.exitCode).toBe(1)
    expect(exec.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/cross-mount not supported/)
  })
})

describe('handleCommand — job builtins', () => {
  it('routes "jobs" to handleJobs when jobTable provided', async () => {
    const reg = new MountRegistry({ '/ram': new StubVFS('ram') }, MountMode.WRITE)
    const jt = new JobTable()
    const [, io] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['jobs'],
      new EvaluationContext(new SessionState({ sessionId: 'test' })),
      null,
      null,
      jt,
    )
    expect(io.exitCode).toBe(0)
  })

  it('routes "kill N" to handleKill', async () => {
    const reg = new MountRegistry({ '/ram': new StubVFS('ram') }, MountMode.WRITE)
    const jt = new JobTable()
    const [, io] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['kill', '999'],
      new EvaluationContext(new SessionState({ sessionId: 'test' })),
      null,
      null,
      jt,
    )
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/No such process/)
  })
})

describe('the words a handler sees', () => {
  // The words after the command name reach the handler as typed, which is
  // where GNU's `missing operand after '<word>'` reads its word. Mirrors
  // python's test_a_handler_sees_the_words_the_line_spelled.
  it.each([
    ['cmp -s', "cmp: missing operand after '-s'\n"],
    ['cmp -n 5 --', "cmp: missing operand after '--'\n"],
    ['diff -u', "diff: missing operand after '-u'\n"],
    ['cd /data && join a.txt -t ,', "join: missing operand after ','\n"],
  ])('%s', async (line, err) => {
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('echo a > /data/a.txt')
    const r = await ws.shell(line)
    expect(new TextDecoder().decode(r.stderr).startsWith(err)).toBe(true)
    await ws.close()
  })
})

describe('dispatched options route nothing', () => {
  // jq's --rawfile/--slurpfile are read and curl's -o/-D written through
  // the dispatcher, so a file on another mount, or a process substitution
  // under /dev, is no cross-mount line (DISPATCH_FLAG_KEYS). Positional operands
  // still route. Mirrors python's test_dispatch_options_route_nothing.
  it.each([
    [
      "jq -c -n --slurpfile t /work/t.json --slurpfile f <(echo '{\"x\":1}') '[$t, $f]'",
      '[[{"a":1}],[{"x":1}]]\n',
    ],
    ["jq -c --slurpfile t /work/t.json '[., $t]' /data/d.json", '[{"b":2},[{"a":1}]]\n'],
    ["cd /work && jq -c -n --rawfile r /data/r.txt '$r'", '"raw\\n"\n'],
  ])('%s', async (line, out) => {
    const ws = new Workspace(
      { '/data/': new RAMVFS(), '/work/': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    await ws.shell(
      'echo \'{"a":1}\' > /work/t.json; echo \'{"b":2}\' > /data/d.json; echo raw > /data/r.txt',
    )
    const r = await ws.shell(line)
    expect([r.exitCode, decode(r.stdout), decode(r.stderr)]).toEqual([0, out, ''])
    await ws.close()
  })
})

class CachedRAM extends RAMVFS {
  override readonly cachesReads = true
}

describe('the cross-mount entry point', () => {
  it('keeps both edited files cached', async () => {
    // The sed relay is its own write path, apart from runDispatch: it claims
    // each -i file, and the line keeps the edited bytes on both mounts, which
    // then serve a cat after the backend changes.
    const enc = new TextEncoder()
    const left = new CachedRAM()
    const right = new CachedRAM()
    left.loadState({ type: 'ram', files: { '/f': enc.encode('a1\n') } })
    right.loadState({ type: 'ram', files: { '/g': enc.encode('a2\n') } })
    const ws = new Workspace({ '/a': left, '/b': right }, { mode: MountMode.WRITE })
    try {
      const result = await ws.shell('sed -i s/a/b/ /a/f /b/g')
      expect(result.exitCode).toBe(0)
      expect(await ws.cache.get('/a/f')).toEqual(enc.encode('b1\n'))
      expect(await ws.cache.get('/b/g')).toEqual(enc.encode('b2\n'))
      left.loadState({ type: 'ram', files: { '/f': enc.encode('changed\n') } })
      const again = await ws.shell('cat /a/f')
      expect(again.stdout).toEqual(enc.encode('b1\n'))
    } finally {
      await ws.close()
    }
  })
})

// Twin of test_an_allowed_wrapper_runs_without_the_program_it_names: a
// session that may run egrep runs it, though egrep runs grep.
describe('a wrapper', () => {
  it('runs where the allow list names it but not the program it runs', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.shell("printf 'a|b\\nx\\n' > /data/e.txt")
      ws.createSession('narrow', { profile: { commands: { allow: ['egrep'] } } })
      const io = await ws.shell("egrep 'a|x' /data/e.txt", { sessionId: 'narrow' })
      expect([io.exitCode, new TextDecoder().decode(io.stdout)]).toEqual([0, 'a|b\nx\n'])
      const plain = await ws.shell('grep x /data/e.txt', { sessionId: 'narrow' })
      expect([plain.exitCode, new TextDecoder().decode(plain.stderr)]).toEqual([
        126,
        'grep: Permission denied\n',
      ])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_mounts_own_egrep_runs_ahead_of_the_wrapper: a mount that
  // registers its own egrep runs it; the wrapper is only the fallback for a
  // name no mount registers.
  it('yields to a mount that registers the name itself', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const own = (): [Uint8Array, IOResult] => [
        new TextEncoder().encode('own egrep\n'),
        new IOResult(),
      ]
      ws.mount('/data').registerCommands(
        command({ name: 'egrep', vfs: 'ram', spec: new CommandSpec(), fn: own }),
      )
      await ws.shell('echo x > /data/e.txt')
      const decoder = new TextDecoder()
      const io = await ws.shell('egrep x /data/e.txt')
      expect([io.exitCode, decoder.decode(io.stdout)]).toEqual([0, 'own egrep\n'])
      const plain = await ws.shell('fgrep x /data/e.txt')
      expect([plain.exitCode, decoder.decode(plain.stdout)]).toEqual([0, 'x\n'])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_recursive_wrapper_meets_a_child_mounts_rule: egrep -r
  // walks as grep -r does, so a child mount's rule on egrep speaks on the
  // ancestor operand.
  it('walks into a child mount whose rule it meets', async () => {
    const ws = new Workspace(
      { '/scratch': new RAMVFS(), '/scratch/child': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        profiles: {
          default: parseSessionProfile({
            mounts: {
              '/scratch/child': {
                commands: { deny: [{ reason: 'boxed', commands: ['egrep'] }] },
              },
            },
          }),
        },
      },
    )
    try {
      await ws.shell('echo x > /scratch/a && echo x > /scratch/child/c')
      const io = await ws.shell('egrep -r x /scratch')
      const decoder = new TextDecoder()
      expect([io.exitCode, decoder.decode(io.stdout), decoder.decode(io.stderr)]).toEqual([
        126,
        '',
        'egrep: Permission denied\n',
      ])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_wrappers_pattern_is_no_path_to_a_path_rule: the
  // whole-line gate reads fgrep's words with grep's spec, so its pattern is
  // no path, while a file operand still is.
  it('keeps its pattern from a path rule', async () => {
    const ws = new Workspace(
      { '/private': new RAMVFS(), '/public': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        profiles: {
          default: parseSessionProfile({
            commands: {
              deny: [{ reason: 'sealed', commands: { fgrep: ['/private/*'] } }],
            },
          }),
        },
      },
    )
    try {
      await ws.shell('echo /private/token > /public/log && echo s > /private/token')
      const decoder = new TextDecoder()
      const io = await ws.shell("fgrep '/private/token' /public/log; echo done")
      expect([io.exitCode, decoder.decode(io.stdout)]).toEqual([0, '/private/token\ndone\n'])
      const refused = await ws.shell('fgrep s /private/token; echo done')
      expect([
        refused.exitCode,
        decoder.decode(refused.stdout),
        decoder.decode(refused.stderr),
      ]).toEqual([1, '', 'fgrep: /private/token: Permission denied\n'])
    } finally {
      await ws.close()
    }
  })
})
