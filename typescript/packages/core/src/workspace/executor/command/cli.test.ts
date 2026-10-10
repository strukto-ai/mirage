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
import { CommandSpec } from '../../../commands/spec/types.ts'
import { CLIHandler } from '../../../commands/cli/types.ts'

import { varsFromEnv } from '../../../workspace/session/session.ts'
import { describe, expect, it, vi } from 'vitest'

import { CLI, type CLIInvocation, type CLIVerbFn } from '../../../commands/cli/types.ts'
import { PartialOutputError } from '../../../commands/errors.ts'
import { Argument, UsageStyle } from '../../../commands/spec/types.ts'
import { FlagView } from '../../../commands/spec/flag_view.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { CachableAsyncIterator } from '../../../io/cachable_iterator.ts'
import { Limit, PathSpec } from '../../../types.ts'
import type { CLIInstall } from '../../cli/types.ts'
import { ScriptSource } from '../../../runtime/types.ts'
import { LanguageRuntime } from '../../../runtime/language.ts'
import { PythonRuntime } from '../../../runtime/python/base.ts'
import { Runtime } from '../../../runtime/base.ts'
import { WorkspaceRuntime } from '../../../runtime/workspace.ts'
import { noWorker } from '../../../runtime/python/pyodide/errors.ts'
import type { RunArgs, RunResult, RuntimeLanguage } from '../../../runtime/types.ts'
import { SessionState } from '../../session/session.ts'
import { dropsMountCaches, handleCli } from './cli.ts'

// Mirrors python/tests/workspace/executor/command/test_cli.py.

const calls: CLIInvocation[] = []
const dec = new TextDecoder()

function send(inv: CLIInvocation): [Uint8Array, IOResult] {
  calls.push(inv)
  const token = (inv.config as { token: string }).token
  return [new TextEncoder().encode(`sent[${token}]\n`), new IOResult()]
}

function makeInstall(name = 'prog'): CLIInstall {
  const spec = new CLI({
    spec: new CommandSpec({
      name: 'prog',
      arguments: [new Argument(['-v', '--verbose'], { action: 'count' })],
      subcommands: [
        new CommandSpec({
          name: 'message',
          subcommands: [
            new CommandSpec({
              name: 'send',
              arguments: [
                new Argument(['-t', '--to'], { required: true }),
                new Argument('texts', { metavar: '', nargs: '*' }),
              ],
            }),
          ],
        }),
      ],
    }),
    handlers: { 'message send': new CLIHandler({ fn: send }) },
    configModel: (input) => input,
  })
  return { name, cli: spec, config: { token: 'tok' } }
}

describe('handleCli', () => {
  it('runs the leaf with config, group flags, and texts', async () => {
    calls.length = 0
    const install = makeInstall()
    const parts = ['prog', '-vv', 'message', 'send', '-t', '#eng', 'hello', 'world']
    const session = new SessionState({ sessionId: 't', vars: varsFromEnv({ EDITOR: 'vi' }) })
    const [stdout, io, node] = await handleCli(install, parts, session)
    expect(io.exitCode).toBe(0)
    expect(dec.decode(await materialize(stdout))).toBe('sent[tok]\n')
    const inv = calls.pop()
    expect((inv?.config as { token: string }).token).toBe('tok')
    expect(inv?.texts).toEqual(['hello', 'world'])
    expect(inv?.flags.to).toBe('#eng')
    expect(inv?.flags.verbose).toBe(2)
    expect(inv?.argv).toEqual(['-vv', 'message', 'send', '-t', '#eng', 'hello', 'world'])
    // $PWD is exported, so a CLI subprocess inherits it as bash's would.
    expect(inv?.env).toEqual({ EDITOR: 'vi', PWD: '/' })
    expect(node.command).toBe('prog -vv message send -t #eng hello world')
    const pathsInstall: CLIInstall = {
      name: 'paths',
      config: { token: 'tok' },
      cli: new CLI({
        spec: new CommandSpec({
          name: 'paths',
          arguments: [
            new Argument('prefix', { nargs: '?' }),
            new Argument('FILE', { type: 'path' }),
            new Argument('--output', {
              type: 'path',
              nargs: 1,
              env: 'OUTPUT',
              default: './default',
            }),
          ],
        }),
        handlers: { '': new CLIHandler({ fn: send }) },
      }),
    }
    for (const words of [['report.txt'], ['prefix', 'report.txt']]) {
      const expectedOutput = words.length > 1 ? 'environment' : 'default'
      const pathSession = new SessionState({
        sessionId: 'paths',
        cwd: '/work',
        vars: varsFromEnv(words.length > 1 ? { OUTPUT: './environment' } : {}),
      })
      const [stdout, result] = await handleCli(pathsInstall, ['paths', ...words], pathSession)
      await materialize(stdout)
      expect(result.exitCode).toBe(0)
      const received = calls.pop()
      expect(received?.texts).toEqual(words.slice(0, -1))
      expect(received?.paths.map((path) => path.virtual)).toEqual(['/work/report.txt'])
      expect(received?.flags.output).toBeInstanceOf(PathSpec)
      const output = new FlagView(received?.flags ?? {}, received?.spec).asPaths('output')
      expect(output.map((path) => [path.virtual, path.rawPath])).toEqual([
        [`/work/${expectedOutput}`, `./${expectedOutput}`],
      ])
    }
  })

  it('refuses an unknown verb with git wording, exit 1', async () => {
    const install = makeInstall('renamed')
    const [, io, node] = await handleCli(
      install,
      ['renamed', 'bogus'],
      new SessionState({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(1)
    expect(dec.decode(await materialize(io.stderr))).toBe(
      "renamed: 'bogus' is not a renamed command. See 'renamed --help'.\n",
    )
    expect(node.exitCode).toBe(1)
  })

  it('bare group prints usage to stdout, exit 1', async () => {
    const install = makeInstall()
    const [stdout, io] = await handleCli(
      install,
      ['prog', 'message'],
      new SessionState({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(1)
    const out = dec.decode(await materialize(stdout))
    expect(out).toContain('usage: prog message')
    expect(out).toContain('send')
  })

  it('leaf --help prints the installed prog, exit 0', async () => {
    const install = makeInstall('renamed')
    const [stdout, io] = await handleCli(
      install,
      ['renamed', 'message', 'send', '--help'],
      new SessionState({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(0)
    const out = dec.decode(await materialize(stdout))
    expect(out.startsWith('usage: renamed message send ')).toBe(true)
    expect(out).toContain('--help')
  })

  it('a leaf declaring --help is handed the flag', async () => {
    // Injection is skipped for a leaf that declares --help, so the
    // answer is the leaf's too: intercepting it anyway would make the
    // declaration unreachable.
    const ownHelp: CLIVerbFn = (inv) => [
      new TextEncoder().encode(`help=${String(inv.flags.help as boolean | undefined)}\n`),
      new IOResult(),
    ]
    const spec = new CLI({
      spec: new CommandSpec({
        name: 'prog',
        arguments: [new Argument('--help', { action: 'store_true', help: 'own help' })],
      }),
      handlers: { '': new CLIHandler({ fn: ownHelp }) },
    })
    const install: CLIInstall = { name: 'prog', cli: spec, config: null }
    const [stdout, io] = await handleCli(
      install,
      ['prog', '--help'],
      new SessionState({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(0)
    expect(dec.decode(await materialize(stdout))).toBe('help=true\n')
  })

  it('leaf usage errors exit 2 with prog attribution', async () => {
    const install = makeInstall()
    const [, io] = await handleCli(
      install,
      ['prog', 'message', 'send', 'hi'],
      new SessionState({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(2)
    expect(dec.decode(await materialize(io.stderr))).toMatch(
      /^prog message send: option '--to' is required/,
    )
  })

  it('the leaf limit bounds the handler', async () => {
    // The declared limit wraps the handler body like mount
    // dispatch: a blocking leaf times out instead of hanging.
    const slow: CLIVerbFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return [null, new IOResult()]
    }
    const spec = new CLI({
      spec: new CommandSpec({ name: 'prog', subcommands: [new CommandSpec({ name: 'run' })] }),
      handlers: { run: new CLIHandler({ fn: slow, limit: new Limit({ timeoutSeconds: 0.05 }) }) },
    })
    const install: CLIInstall = { name: 'prog', cli: spec, config: null }
    await expect(
      handleCli(install, ['prog', 'run'], new SessionState({ sessionId: 't' })),
    ).rejects.toThrow(/prog run: timed out/)
  })

  it('drops the caches when a write times out, and again when it settles', async () => {
    // Racing a promise does not stop its work: the leaf keeps running past
    // exit 124, and its request may land either side of the deadline.
    let dropped = 0
    const dropCaches = (): Promise<void> => {
      dropped += 1
      return Promise.resolve()
    }
    let settled = false
    const slow: CLIVerbFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      settled = true
      return [null, new IOResult()]
    }
    const spec = new CLI({
      spec: new CommandSpec({ name: 'prog', subcommands: [new CommandSpec({ name: 'run' })] }),
      handlers: {
        run: new CLIHandler({ fn: slow, write: true, limit: new Limit({ timeoutSeconds: 0.05 }) }),
      },
      configModel: (input) => input,
    })
    const install: CLIInstall = { name: 'prog', cli: spec, config: {} }
    await expect(
      handleCli(
        install,
        ['prog', 'run'],
        new SessionState({ sessionId: 't' }),
        null,
        {},
        dropCaches,
      ),
    ).rejects.toThrow(/timed out/)
    expect(dropped).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(settled).toBe(true)
    expect(dropped).toBe(2)
  })

  it('reports a drop that fails after the timeout instead of rejecting into nowhere', async () => {
    let calls = 0
    const dropCaches = (): Promise<void> => {
      calls += 1
      return calls === 1 ? Promise.resolve() : Promise.reject(new Error('torn down'))
    }
    const slow: CLIVerbFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return [null, new IOResult()]
    }
    const spec = new CLI({
      spec: new CommandSpec({ name: 'prog', subcommands: [new CommandSpec({ name: 'run' })] }),
      handlers: {
        run: new CLIHandler({ fn: slow, write: true, limit: new Limit({ timeoutSeconds: 0.05 }) }),
      },
      configModel: (input) => input,
    })
    const install: CLIInstall = { name: 'prog', cli: spec, config: {} }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(
        handleCli(
          install,
          ['prog', 'run'],
          new SessionState({ sessionId: 't' }),
          null,
          {},
          dropCaches,
        ),
      ).rejects.toThrow(/timed out/)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(calls).toBe(2)
      expect(unhandled).toEqual([])
      expect(warn).toHaveBeenCalledWith('prog run: cache drop after timeout failed: torn down')
    } finally {
      process.off('unhandledRejection', onUnhandled)
      warn.mockRestore()
    }
  })

  it('carries stdin on the invocation record, never as a flag', async () => {
    calls.length = 0
    const install = makeInstall()
    const stdin = new TextEncoder().encode('body')
    await handleCli(
      install,
      ['prog', 'message', 'send', '-t', 'x'],
      new SessionState({ sessionId: 't' }),
      stdin,
    )
    const inv = calls.pop()
    expect(inv?.stdin).toBe(stdin)
    expect(inv?.flags).not.toHaveProperty('stdin')
  })

  it('carries the session cwd on the invocation record', async () => {
    calls.length = 0
    await handleCli(
      makeInstall(),
      ['prog', 'message', 'send', '-t', 'x'],
      new SessionState({ sessionId: 't', cwd: '/data' }),
    )
    expect(calls.pop()?.cwd.virtual).toBe('/data')
  })
})

class FakePyRuntime extends LanguageRuntime {
  readonly name: string = 'fakepy'
  readonly language: RuntimeLanguage = 'python'
  seen: RunArgs[] = []
  result: RunResult = { stdout: new TextEncoder().encode('ran\n'), stderr: null, exitCode: 0 }

  run(args: RunArgs): Promise<RunResult> {
    this.seen.push(args)
    return Promise.resolve(this.result)
  }
}

class TierPyRuntime extends PythonRuntime {
  seen: RunArgs[] = []

  constructor(readonly name: string) {
    super()
  }

  run(args: RunArgs): Promise<RunResult> {
    this.seen.push(args)
    return Promise.resolve({ stdout: new TextEncoder().encode('ran\n'), stderr: null, exitCode: 0 })
  }
}

class LineBox extends Runtime {
  readonly name = 'box'
}

class GonePyRuntime extends FakePyRuntime {
  override run(): Promise<RunResult> {
    return Promise.reject(noWorker())
  }
}

class OtherPyRuntime extends FakePyRuntime {
  override readonly name = 'otherpy'
}

class FakeJsRuntime extends FakePyRuntime {
  override readonly name = 'fakejs'
  override readonly language: RuntimeLanguage = 'js'
}

class CrashingRuntime extends FakePyRuntime {
  override readonly name = 'crashpy'

  override run(): Promise<RunResult> {
    return Promise.reject(new Error('engine exploded'))
  }
}

class SleepingRuntime extends FakePyRuntime {
  override readonly name = 'sleepy'

  override async run(args: RunArgs): Promise<RunResult> {
    this.seen.push(args)
    await new Promise<void>((resolve) =>
      args.signal?.addEventListener(
        'abort',
        () => {
          resolve()
        },
        { once: true },
      ),
    )
    return this.result
  }
}

function scriptInstall(
  opts: {
    runtime?: string | null
    config?: Record<string, unknown> | null
    language?: RuntimeLanguage
    options?: Argument[]
  } = {},
): CLIInstall {
  const spec = new CLI({
    spec: new CommandSpec({ name: 'pager', arguments: [...(opts.options ?? [])] }),
    script: new ScriptSource("print('hi')", opts.language ?? 'python'),
    runtime: opts.runtime ?? null,
  })
  return { name: 'pager', cli: spec, config: opts.config ?? null }
}

describe('handleCli script arm', () => {
  it('selects by language and runs with verbatim argv', async () => {
    // The python script lands on the python-speaking entry even though
    // a js entry sits first in the world; argv reaches the program
    // verbatim so it can re-parse natively.
    const py = new FakePyRuntime()
    const js = new FakeJsRuntime()
    const [stdout, io, node] = await handleCli(
      scriptInstall(),
      ['pager', 'report.txt', 'x'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [js, py] },
    )
    expect(io.exitCode).toBe(0)
    expect(dec.decode(await materialize(stdout))).toBe('ran\n')
    expect(js.seen).toEqual([])
    const run = py.seen.pop()
    expect(run?.code).toBe("print('hi')")
    expect(run?.args).toEqual(['report.txt', 'x'])
    expect(node.command).toBe('pager report.txt x')
    expect(node.exitCode).toBe(0)
  })

  it('declared options still pass verbatim', async () => {
    // The spec is a typed entry point: a declared option validates,
    // then the program still receives the raw tokens, the contract a
    // native binary could also honor.
    const py = new FakePyRuntime()
    const install = scriptInstall({
      options: [new Argument(['-n', '--lines'], { type: 'int' })],
    })
    const [, io] = await handleCli(
      install,
      ['pager', '-n', '3', 'report.txt'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(0)
    expect(py.seen.pop()?.args).toEqual(['-n', '3', 'report.txt'])
  })

  it('the module bit reaches the runtime as a flag', async () => {
    // A .mjs source only runs as an ES module if the engine gets
    // flags.module; without it import and top-level await fail.
    const js = new FakeJsRuntime()
    const spec = new CLI({
      spec: new CommandSpec({ name: 'pager' }),
      script: new ScriptSource('export const x = 1', 'js', true),
    })
    const install: CLIInstall = { name: 'pager', cli: spec, config: null }
    const [, io] = await handleCli(install, ['pager'], new SessionState({ sessionId: 't' }), null, {
      entries: [js],
    })
    expect(io.exitCode).toBe(0)
    expect(js.seen.pop()?.flags).toEqual({ module: true })
  })

  it('a non-module script sends no flags', async () => {
    const py = new FakePyRuntime()
    await handleCli(scriptInstall(), ['pager'], new SessionState({ sessionId: 't' }), null, {
      entries: [py],
    })
    expect(py.seen.pop()?.flags).toBeUndefined()
  })

  it('the env carries MIRAGE_CLI_CONFIG as JSON', async () => {
    const py = new FakePyRuntime()
    const session = new SessionState({ sessionId: 't', vars: varsFromEnv({ EDITOR: 'vi' }) })
    const [, io] = await handleCli(
      scriptInstall({ config: { apiKey: 'k1' } }),
      ['pager'],
      session,
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(0)
    expect(py.seen.pop()?.env).toEqual({
      EDITOR: 'vi',
      PWD: '/',
      MIRAGE_CLI_CONFIG: '{"apiKey":"k1"}',
    })
  })

  it('the env omits MIRAGE_CLI_CONFIG without config', async () => {
    const py = new FakePyRuntime()
    await handleCli(scriptInstall(), ['pager'], new SessionState({ sessionId: 't' }), null, {
      entries: [py],
    })
    expect(py.seen.pop()?.env).not.toHaveProperty('MIRAGE_CLI_CONFIG')
  })

  it('is named by its installed head word', async () => {
    // The program's own name rides argv slot 0, so its messages read
    // 'pager:' and two installs of one program are distinguishable.
    const py = new FakePyRuntime()
    const install: CLIInstall = { name: 'renamed', cli: scriptInstall().cli, config: null }
    await handleCli(
      install,
      ['renamed', 'report.txt'],
      new SessionState({ sessionId: 't' }),
      null,
      {
        entries: [py],
      },
    )
    const run = py.seen.pop()
    expect(run?.prog).toBe('renamed')
    expect(run?.args).toEqual(['report.txt'])
  })

  it('stdin materializes to bytes', async () => {
    const py = new FakePyRuntime()
    const stdin = new TextEncoder().encode('body')
    await handleCli(scriptInstall(), ['pager'], new SessionState({ sessionId: 't' }), stdin, {
      entries: [py],
    })
    expect(py.seen.pop()?.stdin).toEqual(stdin)
  })

  it('--help reaches a program that declared nothing', async () => {
    // A grammarless script root answers its own --help: mirage would
    // render a page documenting only --help, which documents nothing.
    const py = new FakePyRuntime()
    const [, io] = await handleCli(
      scriptInstall(),
      ['pager', '--help'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(0)
    expect(py.seen.pop()?.args).toEqual(['--help'])
  })

  it('--help renders when the spec declares a grammar', async () => {
    // Declaring options opts back into the entry point, where the
    // rendered page is truthful and the program never runs.
    const py = new FakePyRuntime()
    const install = scriptInstall({
      options: [new Argument(['-n', '--lines'], { type: 'int' })],
    })
    const [stdout, io] = await handleCli(
      install,
      ['pager', '--help'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(0)
    const out = dec.decode(await materialize(stdout))
    expect(out.startsWith('usage: pager ')).toBe(true)
    expect(out).toContain('--lines')
    expect(py.seen).toEqual([])
  })

  it('an undeclared flag reaches the program', async () => {
    // The program is the parser, so a flag it accepts must not be
    // refused on its behalf: a yaml clis entry declares no grammar at
    // all, which would leave the tier operand-only.
    const py = new FakePyRuntime()
    const [, io] = await handleCli(
      scriptInstall(),
      ['pager', '--width', '80', '-n', 'x'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(0)
    expect(py.seen.pop()?.args).toEqual(['--width', '80', '-n', 'x'])
  })

  it('a script with a grammar refuses an undeclared flag', async () => {
    const py = new FakePyRuntime()
    const install = scriptInstall({
      options: [new Argument(['-n', '--lines'], { type: 'int' })],
    })
    const [, io] = await handleCli(
      install,
      ['pager', '--frobnicate'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(2)
    expect(dec.decode(await materialize(io.stderr))).toMatch(
      /^pager: unrecognized option '--frobnicate'/,
    )
    expect(py.seen).toEqual([])
  })

  it('the runtime pin is honored', async () => {
    // The pin overrides first-match: the named entry runs the script
    // even when an earlier entry speaks the same language.
    const first = new FakePyRuntime()
    const pinned = new OtherPyRuntime()
    const [, io] = await handleCli(
      scriptInstall({ runtime: 'otherpy' }),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [first, pinned] },
    )
    expect(io.exitCode).toBe(0)
    expect(first.seen).toEqual([])
    expect(pinned.seen).toHaveLength(1)
  })

  // A route policy or a runtime's script that places this line's python3
  // on the second entry places the script there too.
  it('runs where the line runs its interpreter', async () => {
    const first = new TierPyRuntime('first')
    const second = new TierPyRuntime('second')
    const [, io] = await handleCli(
      scriptInstall(),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      {
        entries: [first, second],
        routing: { bindings: { python3: second, python: second }, fallback: null },
      },
    )
    expect(io.exitCode).toBe(0)
    expect(first.seen).toEqual([])
    expect(second.seen).toHaveLength(1)
  })

  it('is refused when the line refused its interpreter', async () => {
    const py = new TierPyRuntime('first')
    const [, io, node] = await handleCli(
      scriptInstall(),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py], routing: { bindings: { python3: null }, fallback: null } },
    )
    expect(io.exitCode).toBe(126)
    expect(dec.decode(await materialize(io.stderr))).toBe('pager: no runtime accepted this line\n')
    expect(node.exitCode).toBe(126)
    expect(py.seen).toEqual([])
  })

  // A line whose python3 runs inside a sandbox runs no script there, and
  // the entry the line passed over does not run it either.
  it('is refused where the line runs python3 on a runtime without python', async () => {
    const py = new TierPyRuntime('first')
    const [, io] = await handleCli(
      scriptInstall(),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py], routing: { bindings: { python3: new LineBox() }, fallback: null } },
    )
    expect(io.exitCode).toBe(127)
    expect(dec.decode(await materialize(io.stderr))).toBe(
      "pager: runtime 'box' does not run python scripts\n",
    )
    expect(py.seen).toEqual([])
  })

  // The interpreter is missing, not the program: 127, as python3 answers.
  it('exits 127 when its runtime is unavailable', async () => {
    const [, io, node] = await handleCli(
      scriptInstall(),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [new GonePyRuntime()] },
    )
    expect(io.exitCode).toBe(127)
    expect(dec.decode(await materialize(io.stderr))).toBe(`pager: ${noWorker().message}\n`)
    expect(node.exitCode).toBe(127)
  })

  it('runs on the first entry where the workspace serves python3', async () => {
    const py = new TierPyRuntime('first')
    const [, io] = await handleCli(
      scriptInstall(),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py], routing: { bindings: {}, fallback: new WorkspaceRuntime() } },
    )
    expect(io.exitCode).toBe(0)
    expect(py.seen).toHaveLength(1)
  })

  it('an unknown pin exits 127', async () => {
    const py = new FakePyRuntime()
    const [, io, node] = await handleCli(
      scriptInstall({ runtime: 'local' }),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(127)
    expect(dec.decode(await materialize(io.stderr))).toBe(
      "pager: unknown runtime: 'local' (workspace runtimes: 'fakepy')\n",
    )
    expect(node.exitCode).toBe(127)
    expect(py.seen).toEqual([])
  })

  it('a pin language mismatch exits 127', async () => {
    const js = new FakeJsRuntime()
    const [, io] = await handleCli(
      scriptInstall({ runtime: 'fakejs' }),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [js] },
    )
    expect(io.exitCode).toBe(127)
    expect(dec.decode(await materialize(io.stderr))).toBe(
      "pager: runtime 'fakejs' does not run python scripts\n",
    )
    expect(js.seen).toEqual([])
  })

  it('no language match exits 127', async () => {
    const py = new FakePyRuntime()
    const [, io] = await handleCli(
      scriptInstall({ language: 'js' }),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(127)
    expect(dec.decode(await materialize(io.stderr))).toBe(
      "pager: no workspace runtime runs js scripts (workspace runtimes: 'fakepy')\n",
    )
  })

  it('outside a workspace exits 127', async () => {
    const [, io] = await handleCli(scriptInstall(), ['pager'], new SessionState({ sessionId: 't' }))
    expect(io.exitCode).toBe(127)
    expect(dec.decode(await materialize(io.stderr))).toBe(
      'pager: no workspace runtime runs python scripts (workspace runtimes: none)\n',
    )
  })

  it('a crash reports prog-prefixed exit 1', async () => {
    const crash = new CrashingRuntime()
    const [, io] = await handleCli(
      scriptInstall(),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [crash] },
    )
    expect(io.exitCode).toBe(1)
    expect(dec.decode(await materialize(io.stderr))).toBe('pager: engine exploded\n')
  })

  it('the exit code and stderr surface', async () => {
    const py = new FakePyRuntime()
    py.result = {
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode('boom\n'),
      exitCode: 3,
    }
    const [stdout, io, node] = await handleCli(
      scriptInstall(),
      ['pager'],
      new SessionState({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(stdout).toBeNull()
    expect(io.exitCode).toBe(3)
    expect(dec.decode(await materialize(io.stderr))).toBe('boom\n')
    expect(node.exitCode).toBe(3)
  })

  it('the leaf limit bounds the run', async () => {
    const sleepy = new SleepingRuntime()
    const spec = new CLI({
      spec: new CommandSpec({ name: 'pager' }),
      handlers: { '': new CLIHandler({ limit: new Limit({ timeoutSeconds: 0.05 }) }) },
      script: new ScriptSource("print('hi')"),
    })
    const install: CLIInstall = { name: 'pager', cli: spec, config: null }
    await expect(
      handleCli(install, ['pager'], new SessionState({ sessionId: 't' }), null, {
        entries: [sleepy],
      }),
    ).rejects.toThrow(/pager: timed out/)
    expect(sleepy.seen[0]?.timeoutSeconds).toBe(0.05)
    expect(sleepy.seen[0]?.signal?.aborted).toBe(true)
  })
})

describe('a leaf that fails after printing', () => {
  it('keeps what it printed ahead of the diagnostic', async () => {
    const spec = new CLI({
      spec: new CommandSpec({ name: 'prog', subcommands: [new CommandSpec({ name: 'go' })] }),
      handlers: {
        go: new CLIHandler({
          fn: () => {
            throw new PartialOutputError('late boom', new TextEncoder().encode('first\n'))
          },
        }),
      },
      configModel: (input) => input,
    })
    const install: CLIInstall = { name: 'prog', cli: spec, config: { token: 'tok' } }
    const [stdout, io] = await handleCli(
      install,
      ['prog', 'go'],
      new SessionState({ sessionId: 't' }),
    )
    expect(dec.decode(await materialize(stdout))).toBe('first\n')
    expect([io.exitCode, dec.decode(await materialize(io.stderr))]).toEqual([
      1,
      'prog go: late boom\n',
    ])
  })
})

// A write may have landed before the leaf threw: `gh api -X PUT --jq`
// filters a response the service already applied, so the failure arm
// falls back to the spec's static `write` the same way the success arm
// does when a handler's result says nothing.
describe('cache drop on a thrown leaf', () => {
  function throwingInstall(write: boolean): CLIInstall {
    const spec = new CLI({
      spec: new CommandSpec({ name: 'prog', subcommands: [new CommandSpec({ name: 'push' })] }),
      handlers: {
        push: new CLIHandler({
          write,
          fn: () => {
            throw new Error('filter failed after the request')
          },
        }),
      },
      configModel: (input) => input,
    })
    return { name: 'prog', cli: spec, config: { token: 'tok' } }
  }

  it('a write leaf that throws still drops caches', async () => {
    const dropped: boolean[] = []
    const [, io] = await handleCli(
      throwingInstall(true),
      ['prog', 'push'],
      new SessionState({ sessionId: 't' }),
      null,
      {},
      () => {
        dropped.push(true)
        return Promise.resolve()
      },
    )
    expect(io.exitCode).toBe(1)
    expect(dropped).toEqual([true])
  })

  it('a read leaf that throws drops nothing', async () => {
    const dropped: boolean[] = []
    const [, io] = await handleCli(
      throwingInstall(false),
      ['prog', 'push'],
      new SessionState({ sessionId: 't' }),
      null,
      {},
      () => {
        dropped.push(true)
        return Promise.resolve()
      },
    )
    expect(io.exitCode).toBe(1)
    expect(dropped).toEqual([])
  })
})

describe('dropsMountCaches', () => {
  it('is true for a root that reaches a service, false for the git tier', () => {
    // A script root's config is opaque, so it never carries a config model,
    // yet its program may reach a service exactly as an account CLI does;
    // only a root with neither writes through the dispatcher.
    expect(dropsMountCaches(makeInstall().cli)).toBe(true)
    expect(
      dropsMountCaches(
        new CLI({
          spec: new CommandSpec({ name: 'pager' }),
          script: new ScriptSource("print('hi')"),
        }),
      ),
    ).toBe(true)
    expect(
      dropsMountCaches(
        new CLI({
          spec: new CommandSpec({ name: 'tool' }),
          handlers: { '': new CLIHandler({ fn: send }) },
        }),
      ),
    ).toBe(false)
  })
})

it('keeps a custom CLI grammar when it uses Git usage formatting', async () => {
  const spec = new CLI({
    spec: new CommandSpec({
      name: 'custom',
      usageStyle: UsageStyle.GIT,
      subcommands: [
        new CommandSpec({
          name: 'branch',
          arguments: [new Argument('--topic', { action: 'store_true' })],
        }),
      ],
    }),
    handlers: { branch: new CLIHandler({ fn: send }) },
  })
  const install = { name: 'custom', cli: spec, config: { token: 'tok' } }
  const [stdout, io] = await handleCli(
    install,
    ['custom', 'branch', '--top'],
    new SessionState({ sessionId: 't' }),
  )
  expect(io.exitCode).toBe(0)
  expect(dec.decode(await materialize(stdout))).toBe('sent[tok]\n')
})

it.each(['success', 'error', 'abort'] as const)(
  'revokes the invocation shell after %s',
  async (outcome) => {
    const abort = new AbortController()
    const evaluate = vi.fn(() => Promise.resolve(new IOResult()))
    let saved: CLIInvocation['shell']
    const spec = new CLI({
      spec: new CommandSpec({ name: 'probe' }),
      handlers: {
        '': new CLIHandler({
          fn: async (inv) => {
            saved = inv.shell
            if (inv.shell === undefined) throw new Error('missing invocation shell')
            if (outcome === 'abort') {
              abort.abort()
              await expect(inv.shell('echo denied')).rejects.toThrow('no longer active')
            } else {
              await inv.shell('echo allowed')
            }
            if (outcome === 'error') throw new Error('handler failed')
            return [null, new IOResult()]
          },
        }),
      },
    })
    await handleCli(
      { name: 'probe', cli: spec, config: null },
      ['probe'],
      new SessionState({ sessionId: 's' }),
      null,
      { shell: evaluate, signal: abort.signal },
    )
    if (saved === undefined) throw new Error('missing saved shell')
    await expect(saved('echo late')).rejects.toThrow('no longer active')
    expect(evaluate).toHaveBeenCalledTimes(outcome === 'abort' ? 0 : 1)
  },
)

it.each([
  [null, UsageStyle.ARGPARSE, 2],
  [2, UsageStyle.ARGPARSE, 2],
  ['+', UsageStyle.ARGPARSE, 2],
  ['?', UsageStyle.ARGPARSE, 0],
  ['*', UsageStyle.ARGPARSE, 0],
  [null, UsageStyle.GIT, 7],
  [null, UsageStyle.COBRA, 1],
] as const)('handles missing positional arity %j in %s', async (nargs, usageStyle, expected) => {
  const fn = vi.fn((): [null, IOResult] => {
    if (usageStyle === UsageStyle.COBRA) throw new Error('handler requires ID')
    return [null, new IOResult({ exitCode: usageStyle === UsageStyle.GIT ? 7 : 0 })]
  })
  const cli = new CLI({
    spec: new CommandSpec({
      name: 'tool',
      usageStyle,
      subcommands: [new CommandSpec({ name: 'run', arguments: [new Argument('ID', { nargs })] })],
    }),
    handlers: { run: new CLIHandler({ fn }) },
  })
  const install: CLIInstall = { name: 'renamed', cli, config: null }
  const session = new SessionState({ sessionId: 'arity' })
  const [stdout, io] = await handleCli(install, ['renamed', 'run'], session)
  expect(io.exitCode).toBe(expected)
  if (usageStyle === UsageStyle.COBRA) {
    expect(stdout).toBeNull()
    expect(dec.decode(await materialize(io.stderr))).toBe('renamed run: handler requires ID\n')
    const [help, helped] = await handleCli(install, ['renamed', 'run', '-h'], session)
    expect(helped.exitCode).toBe(0)
    expect(dec.decode(await materialize(help))).toMatch(/^usage: renamed run \[-h\] ID\n/)
  }
  if (expected !== 2) expect(fn).toHaveBeenCalledOnce()
  else {
    expect(stdout).toBeNull()
    const message = dec.decode(await materialize(io.stderr))
    expect(message).toMatch(/^usage: renamed run /)
    expect(message).toContain('\nrenamed run: error: the following arguments are required: ID\n')
    const [help, helped] = await handleCli(install, ['renamed', 'run', '--help'], session)
    expect(helped.exitCode).toBe(0)
    expect(dec.decode(await materialize(help))).toMatch(/^usage: renamed run /)
    expect(fn).not.toHaveBeenCalled()
  }
})

it('keeps a cached read whole after the output reads it', async () => {
  async function* source(): AsyncGenerator<Uint8Array> {
    yield await Promise.resolve(new TextEncoder().encode('body'))
  }
  const cli = new CLI({
    spec: new CommandSpec({ name: 'reader' }),
    handlers: {
      '': new CLIHandler({
        fn: () => {
          const stream = source()
          return [stream, new IOResult({ reads: { '/f': stream }, cache: ['/f'] })]
        },
      }),
    },
  })
  const [stdout, io] = await handleCli(
    { name: 'reader', cli, config: null },
    ['reader'],
    new SessionState({ sessionId: 'test' }),
  )
  expect(new TextDecoder().decode(await materialize(stdout))).toBe('body')
  const cached = io.reads['/f']
  expect(cached).toBeInstanceOf(CachableAsyncIterator)
  expect(new TextDecoder().decode(await (cached as CachableAsyncIterator).drain())).toBe('body')
})

it.each([null, 1])(
  'joins native producer when unstarted output closes (timeout=%s)',
  async (timeout) => {
    let closed = false
    const cli = new CLI({
      spec: new CommandSpec({ name: 'writer' }),
      handlers: {
        '': new CLIHandler({
          limit: timeout === null ? null : new Limit({ timeoutSeconds: timeout }),
          fn: () => [
            new HeldSource(new TextEncoder().encode('prefix'), () => {
              closed = true
            }),
            new IOResult(),
          ],
        }),
      },
    })
    const [output] = await handleCli(
      { name: 'writer', cli, config: null },
      ['writer'],
      new SessionState({ sessionId: 'test' }),
    )
    await (output as AsyncIterableIterator<Uint8Array>).return?.()
    expect(closed).toBe(true)
  },
)

/** Yields its bytes once, then waits until it is closed, once. */
class HeldSource implements AsyncIterableIterator<Uint8Array> {
  private sent = false
  private closed = false
  private release: (() => void) | null = null

  constructor(
    private readonly data: Uint8Array,
    private readonly onClose: () => void,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    if (!this.sent) {
      this.sent = true
      return { done: false, value: this.data }
    }
    if (!this.closed) {
      await new Promise<void>((resolve) => {
        this.release = resolve
      })
    }
    return { done: true, value: undefined }
  }

  return(): Promise<IteratorResult<Uint8Array>> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
    this.release?.()
    return Promise.resolve({ done: true, value: undefined })
  }
}
