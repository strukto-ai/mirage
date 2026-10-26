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
import { type Context, command } from '../../../commands/config.ts'
import { CommandSpec, Argument } from '../../../commands/spec/types.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { shellJoin } from '../../../shell/join.ts'
import { describe, expect, it, vi } from 'vitest'
import type { Policy } from '../../../policy/base.ts'
import type { ExecuteResultContext } from '../../../policy/types.ts'
import { PermissionsPolicy } from '../../../policy/builtin/permissions.ts'
import type { CommandRule } from '../../../policy/types.ts'
import { DEFAULT_COMMAND_LIMITS } from '../../../policy/builtin/output_cap.ts'
import { EXTERNAL_COMMANDS } from '../../../runtime/constants.ts'
import { Runtime } from '../../../runtime/base.ts'
import type { OutputFn, Program, RunResult } from '../../../runtime/types.ts'
import { PythonRuntime } from '../../../runtime/python/base.ts'
import {
  LINE_EXECUTOR,
  PROCESS_EXECUTOR,
  type LineExecutor,
  type ProcessExecutor,
} from '../../../runtime/mixin.ts'
import type { RuntimeOptions } from '../../../runtime/config.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Limit, MountMode, type PathSpec } from '../../../types.ts'
import * as globs from '../../expand/globs.ts'
import { Consumer, SHELL_NAMES, lookup, lookupAll } from '../../lookup/index.ts'
import { SessionState } from '../../session/session.ts'
import { abortable, sleep } from '../../../utils/abort.ts'
import { Workspace } from '../../workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** What one process run received: its argv beside the run's context. */
type Request = Context & { argv: readonly string[] }

class ProcessProbe extends Runtime implements ProcessExecutor {
  readonly [PROCESS_EXECUTOR] = true as const
  name = 'probe'
  requests: Request[] = []
  constructor(options: RuntimeOptions = {}) {
    super(options, [EXTERNAL_COMMANDS])
  }
  async runProcess(
    _e: unknown,
    _p: PathSpec[],
    argv: string[],
    ctx: Context,
    _out: OutputFn | undefined,
  ): Promise<RunResult> {
    const stdin = ctx.stdin === null ? null : await abortable(materialize(ctx.stdin), ctx.signal)
    this.requests.push({ ...ctx, stdin, argv })
    return { stdout: stdin ?? ENC.encode('GPU ready\nother\n'), stderr: null, exitCode: 0 }
  }
}

class StreamingProbe extends ProcessProbe {
  streams: Request[] = []

  override async runProcess(
    _e: unknown,
    _p: PathSpec[],
    argv: string[],
    ctx: Context,
    out: OutputFn | undefined,
  ) {
    this.streams.push({ ...ctx, argv })
    const said = ENC.encode(ctx.env?.TOKEN ?? 'unset')
    if (out === undefined) return { stdout: said, stderr: null, exitCode: 0 }
    await out(said)
    return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
  }
}

class DelayedProcessProbe extends ProcessProbe {
  aborted = false

  override async runProcess(_e: unknown, _p: PathSpec[], argv: string[], ctx: Context) {
    this.requests.push({ ...ctx, argv })
    try {
      await sleep(150, ctx.signal)
      return { stdout: ENC.encode('completed\n'), stderr: null, exitCode: 0 }
    } catch (err) {
      this.aborted = ctx.signal?.aborted ?? false
      throw err
    }
  }
}

class InProcessPython extends PythonRuntime {
  readonly name = 'inproc'

  interpret(_engine: unknown, _program: Program, _ctx: Context): Promise<RunResult> {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: null, exitCode: 0 })
  }
}

function workspace(probe: Runtime, others: Runtime[] = []): Workspace {
  return new Workspace(
    { '/': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      runtimes: [probe, ...others],
    },
  )
}

describe('external program capture', () => {
  it('preserves Mirage pipes and VFS redirects', async () => {
    const probe = new ProcessProbe()
    const ws = workspace(probe)
    try {
      const result = await ws.shell("printf 'GPU ready\nother\n' | native-tool | grep GPU > /out")
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('')
      expect(DEC.decode((await ws.shell('cat /out')).stdout)).toBe('GPU ready\n')
      expect(probe.requests).toHaveLength(1)
      expect(probe.requests[0]?.argv).toEqual(['native-tool'])
      expect(probe.requests[0]?.stdin).toEqual(ENC.encode('GPU ready\nother\n'))
    } finally {
      await ws.close()
    }
  })

  it('hands a native runtime chosen for the line the words as typed', async () => {
    const probe = new ProcessProbe({ captures: ['python3'] })
    const ws = workspace(new InProcessPython(), [probe])
    try {
      const result = await ws.shell("python3 -c 'print(1)' arg", { runtime: 'probe' })
      expect(result.exitCode).toBe(0)
      expect(probe.requests[0]?.argv).toEqual(['python3', '-c', 'print(1)', 'arg'])
    } finally {
      await ws.close()
    }
  })

  it('preserves empty argv and native interpreter options, cwd and temporary env', async () => {
    const probe = new ProcessProbe({ captures: ['python3', EXTERNAL_COMMANDS] })
    const ws = workspace(probe)
    try {
      await ws.shell('mkdir /work; cd /work')
      const result = await ws.shell("TOKEN=one python3 -c 'print(1)' -u 'a b' '$(echo literal)' ''")
      expect(result.exitCode).toBe(0)
      expect(probe.requests[0]?.argv).toEqual([
        'python3',
        '-c',
        'print(1)',
        '-u',
        'a b',
        '$(echo literal)',
        '',
      ])
      expect(probe.requests[0]?.cwd.virtual).toBe('/work')
      expect(probe.requests[0]?.env?.TOKEN).toBe('one')
      await ws.shell('native-tool')
      expect(probe.requests[1]?.env?.TOKEN).toBeUndefined()
    } finally {
      await ws.close()
    }
  })

  it('captures temporary launch settings before a native stream is pulled', async () => {
    const probe = new StreamingProbe()
    const ws = workspace(probe)
    try {
      await ws.shell('mkdir /work; cd /work')
      const result = await ws.shell('TOKEN=one PATH=/private/bin native-tool | cat')
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('one')
      expect(probe.streams[0]?.env?.PATH).toBe('/private/bin')
      expect(probe.streams[0]?.cwd.virtual).toBe('/work')
      expect(DEC.decode((await ws.shell('native-tool')).stdout)).toBe('unset')
    } finally {
      await ws.close()
    }
  })

  it('expands globs against the workspace and preserves quoted patterns', async () => {
    const probe = new ProcessProbe()
    const ws = workspace(probe)
    try {
      await ws.shell('mkdir /work; touch /work/a.txt /work/b.txt')
      const result = await ws.shell("native-tool /work/*.txt '/work/*.txt'")
      expect(result.exitCode).toBe(0)
      expect(probe.requests[0]?.argv).toEqual([
        'native-tool',
        '/work/a.txt',
        '/work/b.txt',
        '/work/*.txt',
      ])
    } finally {
      await ws.close()
    }
  })

  it('globs every unquoted word of a fallback program', async () => {
    // bash globs a word whatever it looks like: a leading dot matches the
    // dotfiles and `x=*` a file named `x=1`, and a quoted or unmatched
    // pattern stays the word as typed.
    const probe = new ProcessProbe()
    const ws = workspace(probe)
    try {
      await ws.shell("mkdir /work; touch /work/.a.txt '/work/x=1'; cd /work")
      const result = await ws.shell("native-tool .*.txt x=* '.*.txt' .none*")
      expect(result.exitCode).toBe(0)
      expect(probe.requests[0]?.argv).toEqual(['native-tool', '.a.txt', 'x=1', '.*.txt', '.none*'])
    } finally {
      await ws.close()
    }
  })

  it('names the external route and keeps shell functions in Mirage', async () => {
    const probe = new ProcessProbe({ captures: ['named-tool', EXTERNAL_COMMANDS] })
    const ws = workspace(probe)
    try {
      expect(DEC.decode((await ws.shell('type -t named-tool')).stdout)).toBe('file\n')
      await ws.shell('native-tool() { echo function; }')
      expect(DEC.decode((await ws.shell('native-tool')).stdout)).toBe('function\n')
      expect(probe.requests).toHaveLength(0)
    } finally {
      await ws.close()
    }
  })

  it('runs a name only the fallback takes, which is not found', async () => {
    const probe = new ProcessProbe()
    const ws = workspace(probe)
    try {
      for (const line of [
        'which native-tool',
        'command -v native-tool',
        'type -t native-tool',
        'cat /usr/bin/native-tool',
      ]) {
        const result = await ws.shell(line)
        expect(result.exitCode, line).toBe(1)
        expect(DEC.decode(result.stdout), line).toBe('')
      }
      const typed = await ws.shell('type native-tool')
      expect(DEC.decode(typed.stderr)).toBe('bash: type: native-tool: not found\n')
      expect((await ws.shell('native-tool')).exitCode).toBe(0)
      expect(probe.requests[0]?.argv).toEqual(['native-tool'])
    } finally {
      await ws.close()
    }
  })
})

describe('external program at the line deadline', () => {
  function lineWs(probe: Runtime): Workspace {
    return new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: [probe],
        commandLimits: { line: new Limit({ timeoutSeconds: 0.05 }) },
      },
    )
  }

  it('aborts the process', async () => {
    const probe = new DelayedProcessProbe()
    const ws = lineWs(probe)
    try {
      const result = await ws.shell('native-tool')
      expect(result.exitCode).toBe(124)
      expect(DEC.decode(result.stderr)).toContain('line: timed out after 0.05s')
      expect(probe.requests).toHaveLength(1)
      expect(probe.aborted).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('never starts a program whose stdin arrives past it', async () => {
    const probe = new ProcessProbe()
    const ws = lineWs(probe)
    async function* slowStdin(): AsyncGenerator<Uint8Array> {
      await sleep(150)
      yield ENC.encode('late\n')
    }
    try {
      const result = await ws.shell('native-tool', { stdin: slowStdin() })
      expect(result.exitCode).toBe(124)
      expect(DEC.decode(result.stderr)).toContain('line: timed out after 0.05s')
      expect(probe.requests).toHaveLength(0)
      await sleep(150)
      expect(probe.requests).toHaveLength(0)
    } finally {
      await ws.close()
    }
  })
})

class ShellProbe extends Runtime implements LineExecutor {
  readonly [LINE_EXECUTOR] = true as const
  name = 'shell-probe'
  lines: string[] = []
  runLine(_e: unknown, _p: PathSpec[], _t: string[], ctx: Context): Promise<RunResult> {
    this.lines.push(ctx.flags.c as string)
    return Promise.resolve({ stdout: ENC.encode('ok\n'), stderr: null, exitCode: 0 })
  }
}

function registerBoardList(ws: Workspace): void {
  for (const registered of command({
    name: 'trello board list',
    vfs: 'ram',
    spec: new CommandSpec({
      arguments: [
        new Argument('path', { metavar: '', type: 'path', nargs: '?' }),
        new Argument('texts', { metavar: '', nargs: '*' }),
      ],
    }),
    fn: () => [ENC.encode('ok\n'), new IOResult()],
  }))
    ws.registry.mountForPrefix('/').register(registered)
}

describe('external command routing regressions', () => {
  it.each([
    ['process', 'trello board list', ['trello', 'board', 'list']],
    ['shell', 'trello board list', ['trello', 'board', 'list']],
    ['process', "'trello board list'", ['trello board list']],
    ['shell', "'trello board list'", ['trello board list']],
  ] as const)('preserves %s command tokens for %s', async (kind, head, expected) => {
    const options = { captures: ['trello board list'] }
    const probe = kind === 'process' ? new ProcessProbe(options) : new ShellProbe(options)
    const ws = workspace(probe)
    registerBoardList(ws)
    try {
      const result = await ws.shell(head + " 'a b' '$(echo literal)' ''")
      expect(result.exitCode).toBe(0)
      const tokens = [...expected, 'a b', '$(echo literal)', '']
      if (probe instanceof ProcessProbe) expect(probe.requests[0]?.argv).toEqual(tokens)
      else expect(probe.lines[0]).toBe(shellJoin(tokens))
    } finally {
      await ws.close()
    }
  })

  describe.each([
    ['process', 'trello board list', ['trello', 'board', 'list']],
    ['shell', 'trello board list', ['trello', 'board', 'list']],
    ['process', "'trello board list'", ['trello board list']],
    ['shell', "'trello board list'", ['trello board list']],
  ] as const)('%s boundary expansion for %s', (kind, head, prefix) => {
    it.each([
      ['/base/i*', ['/base/inner']],
      ['/base/*', ['/base/inner', '/base/other']],
    ] as const)('preserves command tokens when expanding %s', async (pattern, matches) => {
      const options = { captures: ['trello board list'] }
      const probe = kind === 'process' ? new ProcessProbe(options) : new ShellProbe(options)
      const ws = new Workspace(
        {
          '/': new RAMVFS(),
          '/base/inner': new RAMVFS(),
          '/base/other': new RAMVFS(),
        },
        { mode: MountMode.EXEC, runtimes: [probe] },
      )
      registerBoardList(ws)
      // Leave the glob pending so command dispatch owns boundary expansion.
      const deferred = vi
        .spyOn(globs, 'resolveGlobs')
        .mockImplementationOnce((parts) => Promise.resolve([...parts]))
      try {
        const result = await ws.shell(`${head} ${pattern} 'a b' ''`)
        expect(result.exitCode).toBe(0)
        const tokens = [...prefix, ...matches, 'a b', '']
        if (probe instanceof ProcessProbe) expect(probe.requests[0]?.argv).toEqual(tokens)
        else expect(probe.lines[0]).toBe(shellJoin(tokens))
      } finally {
        deferred.mockRestore()
        await ws.close()
      }
    })
  })
})

/** The production rule law fed one deny rule as every session's profile. */
function profileRule(rule: CommandRule): PermissionsPolicy {
  return new PermissionsPolicy({ commandsOf: () => ({ allow: null, deny: [rule], ask: [] }) })
}

describe.each(['process', 'shell'] as const)('external %s path admission', (kind) => {
  async function guardedWorkspace(): Promise<[Workspace, ProcessProbe | ShellProbe]> {
    const options = { captures: ['cat', 'grep', 'tar'] }
    const probe = kind === 'process' ? new ProcessProbe(options) : new ShellProbe(options)
    const ws = new Workspace(
      { '/work': new RAMVFS() },
      {
        runtimes: [probe],
        mode: MountMode.EXEC,
        policies: [
          profileRule({
            reason: 'protected',
            commands: ['cat', 'grep', 'tar'],
            paths: ['/work/secret.txt'],
          }),
        ],
      },
    )
    expect((await ws.shell('echo secret > /work/secret.txt')).exitCode).toBe(0)
    expect((await ws.shell('echo public > /work/public.txt')).exitCode).toBe(0)
    await ws.shell('cd /work')
    return [ws, probe]
  }

  it.each([
    'cat secret.txt',
    'cat ./secret.txt',
    'cat /work/secret.txt',
    'cat -- secret.txt',
    'cat s*.txt',
    'grep pattern secret.txt',
    'tar -cf archive.tar -C /work secret.txt',
  ])('refuses %s before delegating to a runtime', async (line) => {
    const [ws, probe] = await guardedWorkspace()
    try {
      const result = await ws.shell(line)
      expect(result.exitCode).not.toBe(0)
      expect(result.refusal?.reason).toBe('protected')
      expect(probe instanceof ProcessProbe ? probe.requests : probe.lines).toHaveLength(0)
    } finally {
      await ws.close()
    }
  })

  it('preserves text operands and shell glob expansion', async () => {
    const [ws, probe] = await guardedWorkspace()
    try {
      const result = await ws.shell('grep secret.txt public*.txt')
      expect(result.exitCode).toBe(0)
      const tokens = ['grep', 'secret.txt', 'public.txt']
      if (probe instanceof ProcessProbe) expect(probe.requests[0]?.argv).toEqual(tokens)
      else expect(probe.lines[0]).toBe(shellJoin(tokens))
    } finally {
      await ws.close()
    }
  })
})

describe.each(['process', 'shell'] as const)('external %s text-slot globs', (kind) => {
  function textWorkspace(
    captures: string[],
    policies: Policy[] = [],
  ): [Workspace, ProcessProbe | ShellProbe] {
    const probe = kind === 'process' ? new ProcessProbe({ captures }) : new ShellProbe({ captures })
    const ws = new Workspace(
      { '/work': new RAMVFS() },
      { runtimes: [probe], mode: MountMode.EXEC, policies },
    )
    return [ws, probe]
  }

  it.each([
    ['python3 s.py *.txt', ['python3', 's.py', 'a.txt', 'b.txt']],
    ['python3 -c p /work/*.txt', ['python3', '-c', 'p', '/work/a.txt', '/work/b.txt']],
    ['python3 s.py ../work/?.txt', ['python3', 's.py', '../work/a.txt', '../work/b.txt']],
    ["python3 s.py '*.txt' \\*.txt", ['python3', 's.py', '*.txt', '*.txt']],
    ['python3 s.py *.none', ['python3', 's.py', '*.none']],
    ['python3 s.py .*.txt', ['python3', 's.py', '.a.txt']],
    ['python3 s.py x=*', ['python3', 's.py', 'x=1']],
    ['python3 s.py .none*', ['python3', 's.py', '.none*']],
    ['shopt -s nullglob; python3 s.py *.none x', ['python3', 's.py', 'x']],
    ['set -f; python3 s.py *.txt', ['python3', 's.py', '*.txt']],
  ] as const)('hands %s the words bash would', async (line, tokens) => {
    const [ws, probe] = textWorkspace(['python3'])
    try {
      await ws.shell("touch /work/a.txt /work/b.txt /work/.a.txt '/work/x=1'")
      await ws.shell('cd /work')
      const result = await ws.shell(line)
      expect(result.exitCode).toBe(0)
      if (probe instanceof ProcessProbe) expect(probe.requests[0]?.argv).toEqual(tokens)
      else expect(probe.lines[0]).toBe(shellJoin([...tokens]))
    } finally {
      await ws.close()
    }
  })

  it('obeys failglob', async () => {
    const [ws, probe] = textWorkspace(['python3'])
    try {
      await ws.shell('cd /work')
      await ws.shell('shopt -s failglob')
      const result = await ws.shell('python3 s.py *.none')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toBe('bash: no match: *.none\n')
      expect(probe instanceof ProcessProbe ? probe.requests : probe.lines).toHaveLength(0)
    } finally {
      await ws.close()
    }
  })

  it('admits the paths of the expanded argv', async () => {
    const [ws, probe] = textWorkspace(
      ['grep', 'python3'],
      [
        profileRule({
          reason: 'protected',
          commands: ['grep', 'python3'],
          paths: ['/work/secret.txt'],
        }),
      ],
    )
    try {
      expect((await ws.shell('echo secret > /work/secret.txt')).exitCode).toBe(0)
      expect((await ws.shell('echo public > /work/public.txt')).exitCode).toBe(0)
      await ws.shell('cd /work')
      // One word fills grep's pattern and its file operand, so the match
      // that lands in the file slot is a path the gate reads.
      const refused = await ws.shell('grep *.txt')
      expect(refused.exitCode).not.toBe(0)
      expect(refused.refusal?.reason).toContain('protected')
      expect(probe instanceof ProcessProbe ? probe.requests : probe.lines).toHaveLength(0)
      // A match in a text slot is text, as the word typed by hand is.
      for (const [line, tokens] of [
        ['grep s*.txt public.txt', ['grep', 'secret.txt', 'public.txt']],
        ['python3 s.py s*.txt', ['python3', 's.py', 'secret.txt']],
      ] as const) {
        const result = await ws.shell(line)
        expect(result.exitCode, line).toBe(0)
        if (probe instanceof ProcessProbe) expect(probe.requests.at(-1)?.argv).toEqual(tokens)
        else expect(probe.lines.at(-1)).toBe(shellJoin([...tokens]))
      }
    } finally {
      await ws.close()
    }
  })
})

describe.each(['process', 'shell'] as const)('interpreter %s script admission', (kind) => {
  async function guardedWorkspace(): Promise<[Workspace, ProcessProbe | ShellProbe]> {
    const options = { captures: ['python', 'python3', 'js', 'node'] }
    const probe = kind === 'process' ? new ProcessProbe(options) : new ShellProbe(options)
    const ws = new Workspace(
      { '/work': new RAMVFS() },
      {
        runtimes: [probe],
        mode: MountMode.EXEC,
        policies: [profileRule({ reason: 'protected', paths: ['/work/*'] })],
      },
    )
    await ws.shell('cd /work')
    return [ws, probe]
  }

  // The script is a file the runtime reads on its own machine, outside
  // every dispatcher, so the gate has to see it as the path it is
  // (`python3 steal.py` reads /work/steal.py exactly as `cat steal.py`
  // does), whatever option run precedes it.
  it.each([
    'python3 /work/steal.py',
    'python3 steal.py',
    'python3 ./steal.py',
    'python3 -u steal.py',
    'python3 -W ignore -- steal.py',
    'node steal.js',
    'node -- /work/steal.js',
    'python ./-',
    'python3 -- /work/-',
    'js ./-',
    'node -- /work/-',
  ])('refuses %s before delegating to a runtime', async (line) => {
    const [ws, probe] = await guardedWorkspace()
    try {
      const result = await ws.shell(line)
      const words = line.split(' ')
      const [name = '', operand = ''] = [words[0], words.at(-1)]
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toBe(`${name}: ${operand}: Permission denied\n`)
      expect(result.refusal?.reason).toBe('protected')
      expect(probe instanceof ProcessProbe ? probe.requests : probe.lines).toHaveLength(0)
    } finally {
      await ws.close()
    }
  })

  // Once -c, -m or -e names the program, every operand is that program's
  // argv, as are the words after a script; none is a file the rule
  // reads, and each reaches the runtime as typed.
  it('hands a program its operands as typed', async () => {
    const [ws, probe] = await guardedWorkspace()
    const lines: [string, string[]][] = [
      ['python - /work/arg', ['python', '-', '/work/arg']],
      ['python3 -u -- - -c x', ['python3', '-u', '--', '-', '-c', 'x']],
      ['js -- - /work/arg', ['js', '--', '-', '/work/arg']],
      ['node - -e x', ['node', '-', '-e', 'x']],
      ["python3 -c 'print(1)' steal.py", ['python3', '-c', 'print(1)', 'steal.py']],
      ['python3 -m json.tool steal.py', ['python3', '-m', 'json.tool', 'steal.py']],
      ['node -e 1 steal.js', ['node', '-e', '1', 'steal.js']],
      ['python3 /open.py steal.py', ['python3', '/open.py', 'steal.py']],
    ]
    try {
      for (const [line] of lines) expect((await ws.shell(line)).exitCode, line).toBe(0)
      const delegated =
        probe instanceof ProcessProbe ? probe.requests.map((r) => r.argv) : probe.lines
      expect(delegated).toEqual(
        lines.map(([, tokens]) => (probe instanceof ProcessProbe ? tokens : shellJoin(tokens))),
      )
    } finally {
      await ws.close()
    }
  })
})

describe.each(['process', 'shell'] as const)('native %s builtin precedence', (kind) => {
  it('keeps builtins in Mirage', async () => {
    const options = { captures: [...SHELL_NAMES] }
    const probe = kind === 'process' ? new ProcessProbe(options) : new ShellProbe(options)
    const ws = workspace(probe)
    try {
      const session = new SessionState({ sessionId: 'lookup' })
      for (const name of SHELL_NAMES) {
        if (['python', 'python3', 'node', 'js', 'ps', 'kill'].includes(name)) continue
        expect(lookup(name, session, ws.registry), name).toBe(Consumer.SESSION)
        const layers = lookupAll(name, session, ws.registry)
        expect(layers[0], name).toBe(Consumer.SESSION)
        expect(layers, name).not.toContain(Consumer.EXTERNAL)
      }
      await ws.shell('mkdir /work')
      expect((await ws.shell('cd /work')).exitCode).toBe(0)
      expect(DEC.decode((await ws.shell('pwd')).stdout)).toBe('/work\n')
      expect((await ws.shell('export NATIVE_TEST=kept')).exitCode).toBe(0)
      expect(DEC.decode((await ws.shell('printf "%s\n" "$NATIVE_TEST"')).stdout)).toBe('kept\n')
      expect(DEC.decode((await ws.shell('echo shell')).stdout)).toBe('shell\n')
      expect(DEC.decode((await ws.shell('type -a echo')).stdout)).toBe(
        'echo is a shell builtin\necho is /usr/bin/echo\n',
      )
      expect(probe instanceof ProcessProbe ? probe.requests : probe.lines).toHaveLength(0)
      for (const name of ['python', 'python3', 'node', 'js']) {
        expect((await ws.shell(name + ' --version')).exitCode).toBe(0)
      }
      expect(probe instanceof ProcessProbe ? probe.requests : probe.lines).toHaveLength(4)
    } finally {
      await ws.close()
    }
  })
})

it.each([
  ['ps', '-eo pid,cmd'],
  ['kill', '-0 456'],
])('explicit %s capture reaches the runtime', async (name, args) => {
  const probe = new ProcessProbe({ captures: [name] })
  const ws = workspace(probe)
  try {
    const result = await ws.shell(`${name} ${args}`)
    expect(result.exitCode).toBe(0)
    expect(probe.requests.map((r) => r.argv)).toEqual([[name, ...args.split(' ')]])
  } finally {
    await ws.close()
  }
})

class FailingProcess extends ProcessProbe {
  override runProcess(): Promise<RunResult> {
    return Promise.reject(new Error('provider unavailable'))
  }
}
it('keeps a provider error on its command and continues the line', async () => {
  const ws = workspace(new FailingProcess())
  try {
    const result = await ws.shell('echo before; failed-tool; echo after')
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('before\nafter\n')
    expect(DEC.decode(result.stderr)).toBe('failed-tool: provider unavailable\n')
  } finally {
    await ws.close()
  }
})

class ErringProbe extends ProcessProbe {
  override async runProcess(
    _e: unknown,
    _p: PathSpec[],
    _argv: string[],
    _ctx: Context,
    _out: OutputFn | undefined,
    errors?: OutputFn,
  ): Promise<RunResult> {
    if (errors === undefined)
      return { stdout: new Uint8Array(), stderr: ENC.encode('whole\n'), exitCode: 0 }
    await errors(ENC.encode('streamed\n'))
    return { stdout: new Uint8Array(), stderr: null, exitCode: 0 }
  }
}

// A program's stderr streams into the line as it arrives and still lands in
// the command's record, which postExecute policies read.
describe('streamed stderr', () => {
  it('stays in the command record', async () => {
    const results: string[] = []
    const seen: Policy = {
      postExecute(ctx: ExecuteResultContext) {
        results.push(JSON.stringify(ctx.results))
        return null
      },
    }
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        runtimes: [new ErringProbe()],
        mode: MountMode.EXEC,
        policies: [seen],
      },
    )
    try {
      const io = await ws.shell('native-tool')
      expect(new TextDecoder().decode(await materialize(io.stderr))).toBe('streamed\n')
      expect(results[0]).toContain('"stderr":"streamed\\n"')
    } finally {
      await ws.close()
    }
  })

  // The record keeps what the program wrote and why it failed, with or
  // without a sink for its stderr.
  it.each(['warn-tool', 'warn-tool && echo done > /out'])(
    'keeps what %s wrote and why it failed',
    async (line) => {
      class WarnsThenFails extends ProcessProbe {
        override async runProcess(
          _e: unknown,
          _p: PathSpec[],
          _argv: string[],
          _ctx: Context,
          _out: OutputFn | undefined,
          errors?: OutputFn,
        ): Promise<RunResult> {
          await errors?.(ENC.encode('warning\n'))
          throw new Error('provider unavailable')
        }
      }
      const results: string[] = []
      const seen: Policy = {
        postExecute(ctx: ExecuteResultContext) {
          results.push(JSON.stringify(ctx.results))
          return null
        },
      }
      const ws = new Workspace(
        { '/': new RAMVFS() },
        {
          runtimes: [new WarnsThenFails()],
          mode: MountMode.EXEC,
          policies: [seen],
        },
      )
      try {
        await ws.shell(line)
        expect(results.join('\n')).toContain('"warning\\nwarn-tool: provider unavailable\\n"')
      } finally {
        await ws.close()
      }
    },
  )
})

class EndlessProbe extends ProcessProbe {
  override async runProcess(
    _e: unknown,
    _p: PathSpec[],
    _argv: string[],
    _ctx: Context,
    out: OutputFn | undefined,
  ): Promise<RunResult> {
    for (;;) await out?.(ENC.encode('y\n'))
  }
}

// A reader that stops early stops the program, as SIGPIPE stops it.
it('exits 141 when its reader stopped it', async () => {
  const ws = new Workspace(
    { '/': new RAMVFS() },
    { runtimes: [new EndlessProbe()], mode: MountMode.EXEC },
  )
  try {
    const io = await ws.shell('endless-tool | head -n 1; echo "${PIPESTATUS[@]}"')
    expect(new TextDecoder().decode(await materialize(io.stdout))).toBe('y\n141 0\n')
  } finally {
    await ws.close()
  }
})

// An output cap stops the program the same way, and the command's record,
// which postExecute policies read, keeps the status it settled with.
it('records a program its cap stopped as 141', async () => {
  DEFAULT_COMMAND_LIMITS['endless-tool'] = new Limit({ maxLines: 1 })
  const results: string[] = []
  const seen: Policy = {
    postExecute(ctx: ExecuteResultContext) {
      results.push(JSON.stringify(ctx.results))
      return null
    },
  }
  const ws = new Workspace(
    { '/': new RAMVFS() },
    {
      runtimes: [new EndlessProbe()],
      mode: MountMode.EXEC,
      policies: [seen],
    },
  )
  try {
    const io = await ws.shell('endless-tool')
    expect(new TextDecoder().decode(await materialize(io.stdout))).toBe('y\n')
    expect(io.exitCode).toBe(141)
    expect(results[0]).toContain('"exitCode":141')
  } finally {
    delete DEFAULT_COMMAND_LIMITS['endless-tool']
    await ws.close()
  }
})
