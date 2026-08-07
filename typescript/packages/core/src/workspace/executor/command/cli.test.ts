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

import { CLISpec, type CLIInvocation, type CLIVerbFn } from '../../../commands/cli/types.ts'
import { Operand, Option } from '../../../commands/spec/types.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { Limit } from '../../../types.ts'
import type { CLIInstall } from '../../cli/types.ts'
import { ScriptSource } from '../../../runtime/policy/types.ts'
import { LanguageRuntime } from '../../../runtime/language.ts'
import type { RunArgs, RunResult, RuntimeLanguage } from '../../../runtime/types.ts'
import { Session } from '../../session/session.ts'
import { handleCli } from './cli.ts'

// Mirrors python/tests/workspace/executor/command/test_cli.py.

const calls: CLIInvocation[] = []
const dec = new TextDecoder()

function send(inv: CLIInvocation): [Uint8Array, IOResult] {
  calls.push(inv)
  const token = (inv.config as { token: string }).token
  return [new TextEncoder().encode(`sent[${token}]\n`), new IOResult()]
}

function makeInstall(name = 'prog'): CLIInstall {
  const spec = new CLISpec({
    name: 'prog',
    configModel: (input) => input,
    options: [new Option({ short: '-v', long: '--verbose', count: true })],
    subcommands: [
      new CLISpec({
        name: 'message',
        subcommands: [
          new CLISpec({
            name: 'send',
            fn: send,
            options: [new Option({ short: '-t', long: '--to', type: 'str', required: true })],
            rest: new Operand({ type: 'str' }),
          }),
        ],
      }),
    ],
  })
  return { name, spec, config: { token: 'tok' } }
}

describe('handleCli', () => {
  it('runs the leaf with config, group flags, and texts', async () => {
    calls.length = 0
    const install = makeInstall()
    const parts = ['prog', '-vv', 'message', 'send', '-t', '#eng', 'hello', 'world']
    const session = new Session({ sessionId: 't', env: { EDITOR: 'vi' } })
    const [stdout, io, node] = await handleCli(install, parts, session)
    expect(io.exitCode).toBe(0)
    expect(dec.decode(await materialize(stdout))).toBe('sent[tok]\n')
    const inv = calls.pop()
    expect((inv?.config as { token: string }).token).toBe('tok')
    expect(inv?.texts).toEqual(['hello', 'world'])
    expect(inv?.flags.to).toBe('#eng')
    expect(inv?.flags.verbose).toBe(2)
    expect(inv?.argv).toEqual(['-vv', 'message', 'send', '-t', '#eng', 'hello', 'world'])
    expect(inv?.env).toEqual({ EDITOR: 'vi' })
    expect(node.command).toBe('prog -vv message send -t #eng hello world')
  })

  it('refuses an unknown verb with git wording, exit 1', async () => {
    const install = makeInstall('renamed')
    const [, io, node] = await handleCli(
      install,
      ['renamed', 'bogus'],
      new Session({ sessionId: 't' }),
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
      new Session({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(1)
    const out = dec.decode(await materialize(stdout))
    expect(out).toContain('Usage: prog message')
    expect(out).toContain('send')
  })

  it('leaf --help prints the installed prog, exit 0', async () => {
    const install = makeInstall('renamed')
    const [stdout, io] = await handleCli(
      install,
      ['renamed', 'message', 'send', '--help'],
      new Session({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(0)
    const out = dec.decode(await materialize(stdout))
    expect(out.startsWith('renamed message send\n')).toBe(true)
    expect(out).toContain('--help')
  })

  it('a leaf declaring --help is handed the flag', async () => {
    // Injection is skipped for a leaf that declares --help, so the
    // answer is the leaf's too: intercepting it anyway would make the
    // declaration unreachable.
    const ownHelp: CLIVerbFn = (inv) => [
      new TextEncoder().encode(`help=${String(inv.flags.help)}\n`),
      new IOResult(),
    ]
    const spec = new CLISpec({
      name: 'prog',
      fn: ownHelp,
      options: [new Option({ long: '--help', description: 'own help' })],
    })
    const install: CLIInstall = { name: 'prog', spec, config: null }
    const [stdout, io] = await handleCli(
      install,
      ['prog', '--help'],
      new Session({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(0)
    expect(dec.decode(await materialize(stdout))).toBe('help=true\n')
  })

  it('leaf usage errors exit 2 with prog attribution', async () => {
    const install = makeInstall()
    const [, io] = await handleCli(
      install,
      ['prog', 'message', 'send', 'hi'],
      new Session({ sessionId: 't' }),
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
    const spec = new CLISpec({
      name: 'prog',
      subcommands: [
        new CLISpec({
          name: 'run',
          fn: slow,
          limit: new Limit({ timeoutSeconds: 0.05 }),
        }),
      ],
    })
    const install: CLIInstall = { name: 'prog', spec, config: null }
    await expect(
      handleCli(install, ['prog', 'run'], new Session({ sessionId: 't' })),
    ).rejects.toThrow(/prog run: timed out/)
  })

  it('carries stdin on the invocation record, never as a flag', async () => {
    calls.length = 0
    const install = makeInstall()
    const stdin = new TextEncoder().encode('body')
    await handleCli(
      install,
      ['prog', 'message', 'send', '-t', 'x'],
      new Session({ sessionId: 't' }),
      stdin,
    )
    const inv = calls.pop()
    expect(inv?.stdin).toBe(stdin)
    expect(inv?.flags).not.toHaveProperty('stdin')
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

  override async run(): Promise<RunResult> {
    await new Promise((resolve) => setTimeout(resolve, 500))
    return this.result
  }
}

function scriptInstall(
  opts: {
    runtime?: string | null
    config?: Record<string, unknown> | null
    language?: RuntimeLanguage
    options?: Option[]
  } = {},
): CLIInstall {
  const spec = new CLISpec({
    name: 'pager',
    script: new ScriptSource("print('hi')", opts.language ?? 'python'),
    runtime: opts.runtime ?? null,
    options: opts.options ?? [],
  })
  return { name: 'pager', spec, config: opts.config ?? null }
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
      new Session({ sessionId: 't' }),
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
    // The spec is a typed front door: a declared option validates,
    // then the program still receives the raw tokens, the contract a
    // native binary could also honor.
    const py = new FakePyRuntime()
    const install = scriptInstall({
      options: [new Option({ short: '-n', long: '--lines', type: 'int' })],
    })
    const [, io] = await handleCli(
      install,
      ['pager', '-n', '3', 'report.txt'],
      new Session({ sessionId: 't' }),
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
    const spec = new CLISpec({
      name: 'pager',
      script: new ScriptSource('export const x = 1', 'js', true),
    })
    const install: CLIInstall = { name: 'pager', spec, config: null }
    const [, io] = await handleCli(install, ['pager'], new Session({ sessionId: 't' }), null, {
      entries: [js],
    })
    expect(io.exitCode).toBe(0)
    expect(js.seen.pop()?.flags).toEqual({ module: true })
  })

  it('a non-module script sends no flags', async () => {
    const py = new FakePyRuntime()
    await handleCli(scriptInstall(), ['pager'], new Session({ sessionId: 't' }), null, {
      entries: [py],
    })
    expect(py.seen.pop()?.flags).toBeUndefined()
  })

  it('the env carries MIRAGE_CLI_CONFIG as JSON', async () => {
    const py = new FakePyRuntime()
    const session = new Session({ sessionId: 't', env: { EDITOR: 'vi' } })
    const [, io] = await handleCli(
      scriptInstall({ config: { apiKey: 'k1' } }),
      ['pager'],
      session,
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(0)
    expect(py.seen.pop()?.env).toEqual({ EDITOR: 'vi', MIRAGE_CLI_CONFIG: '{"apiKey":"k1"}' })
  })

  it('the env omits MIRAGE_CLI_CONFIG without config', async () => {
    const py = new FakePyRuntime()
    await handleCli(scriptInstall(), ['pager'], new Session({ sessionId: 't' }), null, {
      entries: [py],
    })
    expect(py.seen.pop()?.env).not.toHaveProperty('MIRAGE_CLI_CONFIG')
  })

  it('is named by its installed head word', async () => {
    // The program's own name rides argv slot 0, so its messages read
    // 'pager:' and two installs of one program are distinguishable.
    const py = new FakePyRuntime()
    const install: CLIInstall = { name: 'renamed', spec: scriptInstall().spec, config: null }
    await handleCli(install, ['renamed', 'report.txt'], new Session({ sessionId: 't' }), null, {
      entries: [py],
    })
    const run = py.seen.pop()
    expect(run?.prog).toBe('renamed')
    expect(run?.args).toEqual(['report.txt'])
  })

  it('stdin materializes to bytes', async () => {
    const py = new FakePyRuntime()
    const stdin = new TextEncoder().encode('body')
    await handleCli(scriptInstall(), ['pager'], new Session({ sessionId: 't' }), stdin, {
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
      new Session({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(0)
    expect(py.seen.pop()?.args).toEqual(['--help'])
  })

  it('--help renders when the spec declares a grammar', async () => {
    // Declaring options opts back into the front door, where the
    // rendered page is truthful and the program never runs.
    const py = new FakePyRuntime()
    const install = scriptInstall({
      options: [new Option({ short: '-n', long: '--lines', type: 'int' })],
    })
    const [stdout, io] = await handleCli(
      install,
      ['pager', '--help'],
      new Session({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(0)
    const out = dec.decode(await materialize(stdout))
    expect(out.startsWith('pager\n')).toBe(true)
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
      new Session({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(0)
    expect(py.seen.pop()?.args).toEqual(['--width', '80', '-n', 'x'])
  })

  it('a script with a grammar refuses an undeclared flag', async () => {
    const py = new FakePyRuntime()
    const install = scriptInstall({
      options: [new Option({ short: '-n', long: '--lines', type: 'int' })],
    })
    const [, io] = await handleCli(
      install,
      ['pager', '--frobnicate'],
      new Session({ sessionId: 't' }),
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
      new Session({ sessionId: 't' }),
      null,
      { entries: [first, pinned] },
    )
    expect(io.exitCode).toBe(0)
    expect(first.seen).toEqual([])
    expect(pinned.seen).toHaveLength(1)
  })

  it('an unknown pin exits 127', async () => {
    const py = new FakePyRuntime()
    const [, io, node] = await handleCli(
      scriptInstall({ runtime: 'local' }),
      ['pager'],
      new Session({ sessionId: 't' }),
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
      new Session({ sessionId: 't' }),
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
      new Session({ sessionId: 't' }),
      null,
      { entries: [py] },
    )
    expect(io.exitCode).toBe(127)
    expect(dec.decode(await materialize(io.stderr))).toBe(
      "pager: no workspace runtime runs js scripts (workspace runtimes: 'fakepy')\n",
    )
  })

  it('outside a workspace exits 127', async () => {
    const [, io] = await handleCli(scriptInstall(), ['pager'], new Session({ sessionId: 't' }))
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
      new Session({ sessionId: 't' }),
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
      new Session({ sessionId: 't' }),
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
    const spec = new CLISpec({
      name: 'pager',
      script: new ScriptSource("print('hi')"),
      limit: new Limit({ timeoutSeconds: 0.05 }),
    })
    const install: CLIInstall = { name: 'pager', spec, config: null }
    await expect(
      handleCli(install, ['pager'], new Session({ sessionId: 't' }), null, { entries: [sleepy] }),
    ).rejects.toThrow(/pager: timed out/)
  })
})
