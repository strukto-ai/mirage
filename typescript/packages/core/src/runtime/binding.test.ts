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
import { Runtime } from './base.ts'
import type { WorkspaceBinding, RuntimeContext } from './binding.ts'
import { LanguageRuntime } from './language.ts'
import { LINE_EXECUTOR, isLineExecutor, isProcessExecutor } from './mixin.ts'
import { UnsupportedExecutionError } from './errors.ts'
import type { DispatchFn, ExecutionKind, Program, RunResult } from './types.ts'
import { RuntimeFiles } from './files.ts'
import type { Context } from '../commands/config.ts'
import {
  callsAs,
  getCurrentSessionFor,
  runWithCaller,
  runWithSession,
} from '../context/session_context.ts'
import { materialize } from '../io/types.ts'
import { linkView, mountView } from '../commands/builtin/utils/links.ts'
import { MontyRuntime } from './python/monty/runtime.ts'
import { PyodideRuntime } from './python/pyodide/runtime.ts'
import { QuickJsRuntime } from './js/quickjs/runtime.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../types.ts'
import { context } from '../../tests/workspace/fixtures/context.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import type { Policy } from '../policy/base.ts'
import type { Action, SessionContext } from '../policy/types.ts'

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected a bound workspace view')
  return value
}

const enc = new TextEncoder()
const dec = new TextDecoder()

class Probe extends LanguageRuntime {
  readonly name = 'probe'
  readonly language = 'python' as const
  override readonly reach = 'workspace' as const
  readonly contexts: Context[] = []
  bound: WorkspaceBinding | null = null
  override bind(binding: WorkspaceBinding): void {
    super.bind(binding)
    this.bound = binding
  }
  interpret(_engine: unknown, program: Program, ctx: Context): Promise<RunResult> {
    this.contexts.push(ctx)
    return Promise.resolve({ stdout: enc.encode(program.code), stderr: null, exitCode: 0 })
  }
}
class ShellProbe extends Runtime {
  readonly name = 'shell-probe'
  readonly [LINE_EXECUTOR] = true as const
  async runLine(
    _engine: unknown,
    _paths: PathSpec[],
    _texts: string[],
    ctx: Context,
  ): Promise<RunResult> {
    const stdin = ctx.stdin === null ? new Uint8Array() : await materialize(ctx.stdin)
    return {
      stdout: enc.encode(`${ctx.flags.c as string}:${ctx.cwd.virtual}${dec.decode(stdin)}`),
      stderr: null,
      exitCode: 0,
    }
  }
}
class DenySecret implements Policy {
  preSession(ctx: SessionContext): Action | null {
    return ctx.key === 'SECRET' ? { kind: 'deny', reason: 'protected' } : null
  }
}

function world(runtimes?: Runtime[]): Workspace {
  return new Workspace(
    { '/data': new RAMVFS(), '/secret': new RAMVFS() },
    {
      mode: MountMode.EXEC,
      policies: [new DenySecret()],
      ...(runtimes === undefined ? {} : { runtimes }),
    },
  )
}

describe('execution bindings', () => {
  it('makes workspace services available during runtime binding', async () => {
    class EagerProbe extends Probe {
      context?: RuntimeContext
      read?: Promise<unknown>
      prefixes: string[] = []
      links: string[] = []
      override bind(binding: WorkspaceBinding): void {
        super.bind(binding)
        this.context = binding.capture()
        this.prefixes = binding.resolver.prefixes()
        this.links = [...binding.resolver.linkChildren('/data')]
        this.read = required(binding.dispatch)('read', PathSpec.fromStrPath('/data/file')).then(
          ([value]) => value,
        )
      }
    }
    const runtime = new EagerProbe()
    const data = new RAMVFS()
    data.loadState({ type: 'ram', files: { '/file': enc.encode('ready') } })
    const ws = new Workspace({ '/data': data }, { runtimes: [runtime] })
    try {
      expect(runtime.prefixes).toEqual(['/data/', '/dev/'])
      expect(runtime.links).toEqual([])
      expect(required(runtime.context).ctx.cwd.virtual).toBe('/')
      expect(required(runtime.context).ctx.session).not.toBeNull()
      expect(dec.decode((await runtime.read) as Uint8Array)).toBe('ready')
    } finally {
      await ws.close()
    }
  })

  it('declares its kinds and refuses unsupported ones', async () => {
    const language = new Probe(),
      native = new ShellProbe()
    const work = PathSpec.fromStrPath('/work')
    type Request = [string[], Context, ExecutionKind]
    const code: Request = [[], context({ flags: { c: 'hello' } }), 'code']
    const shell: Request = [
      [],
      context({ flags: { c: 'echo hello' }, cwd: work, stdin: enc.encode('!') }),
      'line',
    ]
    const process: Request = [['echo', 'hello'], context({ cwd: work }), 'process']
    expect([language.language, language.reach]).toEqual(['python', 'workspace'])
    expect(isLineExecutor(language)).toBe(false)
    expect([isLineExecutor(native), isProcessExecutor(native)]).toEqual([true, false])
    expect([language.filesystem, native.filesystem]).toEqual([[], []])
    const execute = (runtime: Runtime, [texts, ctx, kind]: Request) =>
      runtime.execute([], texts, ctx, { kind })
    expect(dec.decode((await execute(language, code)).stdout)).toBe('hello')
    expect(dec.decode((await execute(native, shell)).stdout)).toBe('echo hello:/work!')
    for (const [runtime, request] of [
      [language, shell],
      [native, code],
      [native, process],
    ] as const)
      await expect(execute(runtime, request)).rejects.toBeInstanceOf(UnsupportedExecutionError)
  })

  it('retains session permissions and gated writes after capture', async () => {
    const ws = world()
    try {
      await ws.shell('echo private > /secret/a')
      ws.createSession('agent', { profile: { paths: { hide: ['/secret'] } } })
      const context = ws.runtimeContext('agent'),
        other = ws.runtimeContext()
      expect(required(mountView(context.ctx.vfs)).visibleDescendants('/')).not.toContain('/secret')
      const secret = PathSpec.fromStrPath('/secret/a')
      await expect(required(context.ctx.vfs).dispatch('read', secret)).rejects.toThrow()
      const [answer] = await required(other.ctx.vfs).dispatch('read', secret)
      expect(dec.decode(answer as Uint8Array)).toBe('private\n')
      await required(context.ctx.session).set('PUBLIC', 'agent')
      expect(required(context.ctx.session).get('PUBLIC')).toBe('agent')
      expect(required(other.ctx.session).get('PUBLIC')).toBeNull()
      expect(context.ctx.env?.PUBLIC).toBeUndefined()
      await expect(required(context.ctx.session).set('SECRET', 'no')).rejects.toMatchObject({
        refusal: { reason: 'protected' },
      })
      const reads = await Promise.all([
        runWithCaller(context.caller, async () => {
          await Promise.resolve()
          return required(context.ctx.session).get('PUBLIC')
        }),
        runWithCaller(other.caller, async () => {
          await Promise.resolve()
          return required(other.ctx.session).get('PUBLIC')
        }),
      ])
      expect(reads).toEqual(['agent', null])
    } finally {
      await ws.close()
    }
  })

  it('projects live mounts, namespace links, and attributes through the binding', async () => {
    const probe = new Probe()
    const ws = world([probe])
    try {
      await ws.shell('echo shared > /data/a; chmod 600 /data/a')
      const context = ws.runtimeContext()
      await ws.shell('ln -s /data/a /data/link')
      expect(required(linkView(context.ctx.vfs)).resolve('/data/link')).toBe('/data/a')
      ws.addMount('/data/nested', new RAMVFS(), MountMode.EXEC)
      const binding = required(probe.bound)
      expect(callsAs(context.caller, () => binding.resolver.ownerOf('/data/nested/a'))()).toBe(
        '/data/nested/',
      )
      const vfs = required(callsAs(context.caller, () => RuntimeFiles.of(context.ctx, binding))())
      expect(dec.decode(await vfs.read('/data/link'))).toBe('shared\n')
      expect((await vfs.stat('/data/a')).mode & 0o777).toBe(0o600)
    } finally {
      await ws.close()
    }
  })

  it('refuses sharing an instance across workspaces', async () => {
    const runtime = new Probe()
    const first = world([runtime]),
      second = world()
    try {
      const ok = await runtime.execute([], [], context({ flags: { c: 'ok' } }))
      expect(dec.decode(ok.stdout)).toBe('ok')
      expect(() => second.addRuntime(runtime)).toThrow('another workspace')
    } finally {
      await first.close()
      await second.close()
    }
  })
})

it.each([
  ['monty', () => new MontyRuntime()],
  ['quickjs', () => new QuickJsRuntime()],
  ['pyodide', () => new PyodideRuntime()],
] as const)(
  '%s uses each execution context for filesystem callbacks',
  async (_name, create) => {
    const runtime = create()
    const expected = ['read', 'write', 'list', 'stat']
    expect(runtime.filesystem).toEqual(_name === 'pyodide' ? [...expected, 'glob'] : expected)
    const ws = world([runtime])
    try {
      await ws.shell('echo shared > /data/file; ln -s /data/file /data/link')
      ws.createSession('one')
      ws.createSession('two')
      const calls: Record<string, string[]> = { one: [], two: [] }
      // The program's own calls reach the dispatcher as the session each
      // run launched under, however the two interleave.
      const dispatcher = (ws as unknown as { dispatcher: { dispatch: DispatchFn } }).dispatcher
      const dispatch = dispatcher.dispatch
      dispatcher.dispatch = (op, path, ...rest) => {
        const session = getCurrentSessionFor(ws.sessionManager)?.sessionId ?? ''
        calls[session]?.push(`${op}:${path.virtual}`)
        return dispatch(op, path, ...rest)
      }
      const code =
        runtime.language === 'js'
          ? "const f = std.open('/data/link', 'r'); std.out.puts(f.readAsString()); f.close()"
          : "print(open('/data/link').read(), end='')"
      const results = await Promise.all(
        ['one', 'two'].map((session) =>
          runWithSession(
            ws.getSession(session),
            () => runtime.execute([], [], context({ flags: { c: code } })),
            { owner: ws.sessionManager },
          ),
        ),
      )
      for (const result of results) {
        expect(result.exitCode, dec.decode(result.stderr ?? new Uint8Array())).toBe(0)
        expect(dec.decode(result.stdout)).toBe('shared\n')
      }
      for (const entries of Object.values(calls))
        expect(entries.some((entry) => /^read:\/data\/(file|link)$/.test(entry))).toBe(true)
    } finally {
      await ws.close()
    }
  },
  60_000,
)

it('command execution supplies its active workspace context', async () => {
  const runtime = new Probe({ captures: ['python3'] })
  const ws = world([runtime])
  try {
    ws.createSession('agent')
    await ws.shell('export PUBLIC=agent; cd /data', { sessionId: 'agent' })
    const result = await ws.shell('python3 -c hello', { sessionId: 'agent' })
    expect(dec.decode(result.stdout)).toBe('hello')
    const captured = required(runtime.contexts.at(-1))
    expect(captured.cwd.virtual).toBe('/data')
    expect(captured.env?.PUBLIC).toBe('agent')
    expect(required(captured.session).get('PUBLIC')).toBe('agent')
    await ws.shell('python3 -c other')
    expect(required(runtime.contexts.at(-1)).env?.PUBLIC).toBeUndefined()
    expect(required(captured.session).get('PUBLIC')).toBe('agent')
  } finally {
    await ws.close()
  }
})

it('does not share process views by profile or follow reused session IDs', async () => {
  const ws = new Workspace({}, { runtimes: [], profiles: { agent: {} } })
  try {
    ws.createSession('one', { profile: 'agent' })
    ws.createSession('two', { profile: 'agent' })
    const one = required(ws.runtimeContext('one').ctx.processes)
    const two = required(ws.runtimeContext('two').ctx.processes)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const process = ws.processes.start({
      sessionId: 'one',
      command: 'private work',
      cwd: PathSpec.fromStrPath('/'),
      cancel: () => undefined,
      run: async () => {
        await gate
        return 0
      },
    })
    expect(one.list()).toEqual([process.info])
    expect(two.list()).toEqual([])
    await ws.closeSession('one')
    ws.createSession('one', { profile: 'agent' })
    expect(one.list()).toEqual([])
    expect(required(ws.runtimeContext('one').ctx.processes).list()).toEqual([])
    release()
    await process.join()
  } finally {
    await ws.close()
  }
})

it('refuses a native runtime before running with hidden files', async () => {
  const runtime = new ShellProbe({ captures: ['@line'] })
  const ws = world([runtime])
  try {
    ws.createSession('restricted', { profile: { paths: { hide: ['/data/secret'] } } })
    const result = await ws.shell('echo should-not-run', { sessionId: 'restricted' })
    expect(result.exitCode).toBe(126)
    expect(dec.decode(result.stdout)).toBe('')
    expect(dec.decode(result.stderr)).toBe(`${runtime.name}: Permission denied\n`)
    expect(result.refusal?.reason).toBe("runtime cannot enforce this session's file restrictions")
  } finally {
    await ws.close()
  }
})

it.each([
  [['/data/secret'], ['/data/']],
  [
    ['/secret', '/data/secret'],
    ['/', '/data/'],
  ],
  [['/data/*'], ['/data/']],
])('maps restrictions to their owning mount: %s', async (hide, expected) => {
  const ws = new Workspace({ '/data': new RAMVFS() }, { runtimes: [] })
  try {
    ws.createSession('agent', { profile: { paths: { hide } } })
    expect(ws.runtimeContext('agent').restrictedMounts).toEqual(expected)
  } finally {
    await ws.close()
  }
})
