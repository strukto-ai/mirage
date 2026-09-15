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

import { CLISpec } from '../../../commands/cli/types.ts'
import { command } from '../../../commands/config.ts'
import { CommandSpec, Operand } from '../../../commands/spec/types.ts'
import { IOResult } from '../../../io/types.ts'
import { shellJoin } from '../../../shell/join.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RulePolicy } from '../../../policy/rule.ts'
import { DEFAULT_COMMAND_LIMITS } from '../../../policy/builtin/output_cap.ts'
import { EXTERNAL_COMMANDS } from '../../../runtime/constants.ts'
import { Runtime } from '../../../runtime/base.ts'
import { MontyRuntime } from '../../../runtime/python/monty/runtime.ts'
import { ScriptSource, type RouteContext } from '../../../runtime/routing/types.ts'
import {
  LINE_EXECUTOR,
  PROCESS_EXECUTOR,
  type LineExecutor,
  type ProcessExecutor,
} from '../../../runtime/mixin.ts'
import type { ProcessExecution, RunResult, RuntimeOptions } from '../../../runtime/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { Limit, MountMode } from '../../../types.ts'
import * as globs from '../../expand/globs.ts'
import { Consumer, SHELL_NAMES, lookup, lookupAll } from '../../lookup/index.ts'
import { Session } from '../../session/session.ts'
import { sleep } from '../../abort.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { getTestParser } from '../../fixtures/workspace_fixture.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

class ProcessProbe extends Runtime implements ProcessExecutor {
  readonly [PROCESS_EXECUTOR] = true as const
  name = 'probe'
  requests: ProcessExecution[] = []
  constructor(options: RuntimeOptions = {}) {
    super(options, [EXTERNAL_COMMANDS])
  }
  runProcess(request: ProcessExecution): Promise<RunResult> {
    this.requests.push(request)
    return Promise.resolve({
      stdout: request.stdin ?? ENC.encode('GPU ready\nother\n'),
      stderr: null,
      exitCode: 0,
    })
  }
}

class DelayedProcessProbe extends ProcessProbe {
  aborted = false

  override async runProcess(request: ProcessExecution): Promise<RunResult> {
    this.requests.push(request)
    try {
      await sleep(150, request.signal)
      return { stdout: ENC.encode('completed\n'), stderr: null, exitCode: 0 }
    } catch (err) {
      this.aborted = request.signal?.aborted ?? false
      throw err
    }
  }
}

async function workspace(probe: Runtime, others: Runtime[] = []): Promise<Workspace> {
  return new Workspace(
    { '/': new RAMResource() },
    {
      mode: MountMode.EXEC,
      shellParser: await getTestParser(),
      runtimes: [probe, ...others],
    },
  )
}

describe('external program capture', () => {
  it('preserves Mirage pipes and VFS redirects', async () => {
    const probe = new ProcessProbe()
    const ws = await workspace(probe)
    try {
      const result = await ws.execute("printf 'GPU ready\nother\n' | native-tool | grep GPU > /out")
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('')
      expect(DEC.decode((await ws.execute('cat /out')).stdout)).toBe('GPU ready\n')
      expect(probe.requests).toHaveLength(1)
      expect(probe.requests[0]?.argv).toEqual(['native-tool'])
      expect(DEC.decode(probe.requests[0]?.stdin ?? undefined)).toBe('GPU ready\nother\n')
    } finally {
      await ws.close()
    }
  })

  it('preserves empty argv and native interpreter options, cwd and temporary env', async () => {
    const probe = new ProcessProbe({ captures: ['python3', EXTERNAL_COMMANDS] })
    const ws = await workspace(probe)
    try {
      await ws.execute('mkdir /work; cd /work')
      const result = await ws.execute(
        "TOKEN=one python3 -c 'print(1)' -u 'a b' '$(echo literal)' ''",
      )
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
      expect(probe.requests[0]?.env.TOKEN).toBe('one')
      await ws.execute('native-tool')
      expect(probe.requests[1]?.env.TOKEN).toBeUndefined()
    } finally {
      await ws.close()
    }
  })

  it('expands globs against the workspace and preserves quoted patterns', async () => {
    const probe = new ProcessProbe()
    const ws = await workspace(probe)
    try {
      await ws.execute('mkdir /work; touch /work/a.txt /work/b.txt')
      const result = await ws.execute("native-tool /work/*.txt '/work/*.txt'")
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

  it('never uses the external fallback for a refused named capture', async () => {
    const probe = new ProcessProbe({ captures: ['native-tool'], script: () => false })
    const fallback = new ProcessProbe()
    fallback.name = 'fallback'
    const ws = await workspace(probe, [fallback])
    try {
      expect((await ws.execute('native-tool')).exitCode).toBe(126)
      expect(probe.requests).toHaveLength(0)
      expect(fallback.requests).toHaveLength(0)
      expect((await ws.execute('another-tool')).exitCode).toBe(0)
      expect(fallback.requests).toHaveLength(1)
    } finally {
      await ws.close()
    }
  })

  it.each([
    { kind: 'named', captures: ['native-tool'] },
    { kind: 'fallback', captures: [EXTERNAL_COMMANDS] },
  ])('does not expand globs for a refused $kind capture', async ({ captures }) => {
    const probe = new ProcessProbe({ captures, script: () => false })
    const ws = await workspace(probe)
    try {
      expect(DEC.decode((await ws.execute('echo mirage')).stdout)).toBe('mirage\n')
      await ws.execute('shopt -s failglob')
      const resolved = vi.spyOn(globs, 'resolveGlobs')
      try {
        const result = await ws.execute('native-tool /api/*')
        expect(result.exitCode).toBe(126)
        expect(DEC.decode(result.stderr)).toBe('native-tool: no runtime accepted this line\n')
        expect(resolved).not.toHaveBeenCalled()
        expect(probe.requests).toHaveLength(0)
      } finally {
        resolved.mockRestore()
      }
    } finally {
      await ws.close()
    }
  })

  it('names the external route and keeps shell functions in Mirage', async () => {
    const probe = new ProcessProbe()
    const ws = await workspace(probe)
    try {
      expect(DEC.decode((await ws.execute('type -t native-tool')).stdout)).toBe('external\n')
      await ws.execute('native-tool() { echo function; }')
      expect(DEC.decode((await ws.execute('native-tool')).stdout)).toBe('function\n')
      expect(probe.requests).toHaveLength(0)
    } finally {
      await ws.close()
    }
  })
})

describe('external program timeout', () => {
  afterEach(() => {
    delete DEFAULT_COMMAND_LIMITS['native-tool']
    delete DEFAULT_COMMAND_LIMITS.python3
  })

  it.each([
    ['native-tool', 1],
    ['native-tool', 0],
    ['native-tool', null],
    ['python3', 1],
    ['python3', 0],
    ['python3', null],
  ] as const)('honors %s mount timeout %s beyond the default', async (name, timeout) => {
    DEFAULT_COMMAND_LIMITS[name] = new Limit({ timeoutSeconds: 0.05 })
    const probe = new DelayedProcessProbe({ captures: ['python3', EXTERNAL_COMMANDS] })
    const ws = await workspace(probe)
    for (const mount of ws.registry.allMounts()) {
      mount.commandLimits.set(name, new Limit({ timeoutSeconds: timeout }))
    }
    try {
      const result = await ws.execute(`PROGRAM=${name}; $PROGRAM`)
      expect(result.exitCode).toBe(0)
      expect(DEC.decode(result.stdout)).toBe('completed\n')
      expect(probe.requests).toHaveLength(1)
      expect(probe.aborted).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it.each(['default', 'mount'])('aborts the process when the %s timeout fires', async (source) => {
    DEFAULT_COMMAND_LIMITS['native-tool'] = new Limit({
      timeoutSeconds: source === 'default' ? 0.05 : 1,
    })
    const probe = new DelayedProcessProbe()
    const ws = await workspace(probe)
    if (source === 'mount') {
      for (const mount of ws.registry.allMounts()) {
        mount.commandLimits.set('native-tool', new Limit({ timeoutSeconds: 0.05 }))
      }
    }
    try {
      const result = await ws.execute('native-tool')
      expect(result.exitCode).toBe(124)
      expect(DEC.decode(result.stderr)).toContain('native-tool: timed out after 0.05s')
      expect(probe.requests).toHaveLength(1)
      expect(probe.aborted).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('includes stdin materialization in the timeout', async () => {
    DEFAULT_COMMAND_LIMITS['native-tool'] = new Limit({ timeoutSeconds: 0.05 })
    const probe = new ProcessProbe()
    const ws = await workspace(probe)
    async function* slowStdin(): AsyncGenerator<Uint8Array> {
      await sleep(150)
      yield ENC.encode('late\n')
    }
    try {
      const result = await ws.execute('native-tool', { stdin: slowStdin() })
      expect(result.exitCode).toBe(124)
      expect(DEC.decode(result.stderr)).toContain('native-tool: timed out after 0.05s')
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
  runLine(line: string): Promise<RunResult> {
    this.lines.push(line)
    return Promise.resolve({ stdout: ENC.encode('ok\n'), stderr: null, exitCode: 0 })
  }
}

function registerBoardList(ws: Workspace): void {
  for (const registered of command({
    name: 'trello board list',
    resource: 'ram',
    spec: new CommandSpec({ positional: [new Operand()], rest: new Operand({ type: 'str' }) }),
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
    const ws = await workspace(probe)
    registerBoardList(ws)
    try {
      const result = await ws.execute(head + " 'a b' '$(echo literal)' ''")
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
          '/': new RAMResource(),
          '/base/inner': new RAMResource(),
          '/base/other': new RAMResource(),
        },
        { mode: MountMode.EXEC, shellParser: await getTestParser(), runtimes: [probe] },
      )
      registerBoardList(ws)
      // Leave the glob pending so command dispatch owns boundary expansion.
      const deferred = vi
        .spyOn(globs, 'resolveGlobs')
        .mockImplementationOnce((parts) => Promise.resolve([...parts]))
      try {
        const result = await ws.execute(`${head} ${pattern} 'a b' ''`)
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

  describe.each(['process', 'shell'] as const)('scripted multiword %s capture', (kind) => {
    it.each([false, true])('resolves its full command with source=%s', async (source) => {
      const script = source
        ? new ScriptSource(
            "ctx['command'] == 'trello board list' and " +
              "ctx['commands'][-1]['command'] == 'trello board list' and " +
              "ctx['commands'][-1]['words'][-1] == '/allowed'",
          )
        : (ctx: RouteContext) =>
            ctx.command === 'trello board list' &&
            ctx.commands.at(-1)?.command === 'trello board list' &&
            ctx.commands.at(-1)?.words.at(-1) === '/allowed'
      const options = { captures: ['trello board list'], script }
      const probe = kind === 'process' ? new ProcessProbe(options) : new ShellProbe(options)
      const ws = await workspace(probe, [new MontyRuntime({ captures: [] })])
      registerBoardList(ws)
      try {
        expect((await ws.execute('echo ok | trello board list /allowed')).exitCode).toBe(0)
        const tokens = ['trello', 'board', 'list', '/allowed']
        if (probe instanceof ProcessProbe) {
          expect(probe.requests[0]?.argv).toEqual(tokens)
          probe.requests.length = 0
        } else {
          expect(probe.lines[0]).toBe(shellJoin(tokens))
          probe.lines.length = 0
        }
        expect((await ws.execute('echo ok | trello board list /denied')).exitCode).toBe(126)
        expect(probe instanceof ProcessProbe ? probe.requests : probe.lines).toHaveLength(0)
      } finally {
        await ws.close()
      }
    })
  })

  it.each(['echo ok', 'cat /input', 'custom-stage', 'trello board list', 'custom-cli', 'python3'])(
    'resolves the external script stage after %s',
    async (head) => {
      const seen: string[] = []
      const probe = new ProcessProbe({
        script: (ctx) => {
          seen.push(ctx.command)
          return ctx.command === 'native-tool'
        },
      })
      const named = new ProcessProbe({ captures: ['python3'] })
      named.name = 'named'
      const ws = await workspace(probe, [named])
      registerBoardList(ws)
      try {
        ws.registerCli(
          'custom-cli',
          new CLISpec({ name: 'custom-cli', fn: () => [ENC.encode('ok\n'), new IOResult()] }),
        )
        await ws.execute('echo ok > /input')
        await ws.execute('custom-stage() { echo ok; }')
        seen.length = 0
        expect((await ws.execute(head + ' | native-tool')).exitCode).toBe(0)
        expect(probe.requests).toHaveLength(1)
        expect(seen).toEqual(['native-tool'])
        probe.requests.length = 0
        expect((await ws.execute(head + ' | denied-tool')).exitCode).toBe(126)
        expect(probe.requests).toHaveLength(0)
      } finally {
        await ws.close()
      }
    },
  )
})

describe.each(['process', 'shell'] as const)('external %s path admission', (kind) => {
  async function guardedWorkspace(): Promise<[Workspace, ProcessProbe | ShellProbe]> {
    const options = { captures: ['cat', 'grep', 'tar'] }
    const probe = kind === 'process' ? new ProcessProbe(options) : new ShellProbe(options)
    const ws = new Workspace(
      { '/work': new RAMResource() },
      {
        shellParser: await getTestParser(),
        runtimes: [probe],
        mode: MountMode.EXEC,
        policies: [
          new RulePolicy({
            reason: 'protected',
            commands: ['cat', 'grep', 'tar'],
            paths: ['/work/secret.txt'],
          }),
        ],
      },
    )
    expect((await ws.execute('echo secret > /work/secret.txt')).exitCode).toBe(0)
    expect((await ws.execute('echo public > /work/public.txt')).exitCode).toBe(0)
    await ws.execute('cd /work')
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
      const result = await ws.execute(line)
      expect(result.exitCode).not.toBe(0)
      expect(DEC.decode(result.stderr)).toContain('protected')
      expect(probe instanceof ProcessProbe ? probe.requests : probe.lines).toHaveLength(0)
    } finally {
      await ws.close()
    }
  })

  it('preserves text operands and shell glob expansion', async () => {
    const [ws, probe] = await guardedWorkspace()
    try {
      const result = await ws.execute('grep secret.txt public*.txt')
      expect(result.exitCode).toBe(0)
      const tokens = ['grep', 'secret.txt', 'public.txt']
      if (probe instanceof ProcessProbe) expect(probe.requests[0]?.argv).toEqual(tokens)
      else expect(probe.lines[0]).toBe(shellJoin(tokens))
    } finally {
      await ws.close()
    }
  })
})

describe.each(['process', 'shell'] as const)('native %s builtin precedence', (kind) => {
  it.each([true, false])('keeps builtins in Mirage when willingness is %s', async (willing) => {
    const options = { captures: [...SHELL_NAMES], script: () => willing }
    const probe = kind === 'process' ? new ProcessProbe(options) : new ShellProbe(options)
    const ws = await workspace(probe)
    try {
      const session = new Session({ sessionId: 'lookup' })
      for (const name of SHELL_NAMES) {
        if (['python', 'python3', 'node', 'js'].includes(name)) continue
        expect(lookup(name, session, ws.registry), name).toBe(Consumer.SESSION)
        const layers = lookupAll(name, session, ws.registry)
        expect(layers[0], name).toBe(Consumer.SESSION)
        expect(layers, name).not.toContain(Consumer.EXTERNAL)
      }
      await ws.execute('mkdir /work')
      expect((await ws.execute('cd /work')).exitCode).toBe(0)
      expect(DEC.decode((await ws.execute('pwd')).stdout)).toBe('/work\n')
      expect((await ws.execute('export NATIVE_TEST=kept')).exitCode).toBe(0)
      expect(DEC.decode((await ws.execute('printf "%s\n" "$NATIVE_TEST"')).stdout)).toBe('kept\n')
      expect(DEC.decode((await ws.execute('echo shell')).stdout)).toBe('shell\n')
      expect(DEC.decode((await ws.execute('type -a echo')).stdout)).toBe(
        'echo is a shell builtin\n',
      )
      expect(probe instanceof ProcessProbe ? probe.requests : probe.lines).toHaveLength(0)
      for (const name of ['python', 'python3', 'node', 'js']) {
        expect((await ws.execute(name + ' --version')).exitCode).toBe(willing ? 0 : 126)
      }
      expect(probe instanceof ProcessProbe ? probe.requests : probe.lines).toHaveLength(
        willing ? 4 : 0,
      )
    } finally {
      await ws.close()
    }
  })
})
