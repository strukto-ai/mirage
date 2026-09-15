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
import type { WorkspaceBinding } from './binding.ts'
import { LanguageRuntime } from './language.ts'
import { LINE_EXECUTOR } from './mixin.ts'
import { UnsupportedExecutionError } from './errors.ts'
import type { RunArgs, RunResult, RuntimeContext } from './types.ts'
import { RuntimeVFS } from './vfs.ts'
import { MontyRuntime } from './python/monty/runtime.ts'
import { PyodideRuntime } from './python/pyodide/runtime.ts'
import { QuickJsRuntime } from './js/quickjs/runtime.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode, PathSpec } from '../types.ts'
import { getTestParser } from '../workspace/fixtures/workspace_fixture.ts'
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
  override readonly reach = 'vfs' as const
  readonly contexts: RuntimeContext[] = []
  protected override executeCode(request: RunArgs, context?: RuntimeContext): Promise<RunResult> {
    if (context !== undefined) this.contexts.push(context)
    return super.executeCode(request, context)
  }
  run(args: RunArgs): Promise<RunResult> {
    return Promise.resolve({ stdout: enc.encode(args.code), stderr: null, exitCode: 0 })
  }
}
class ShellProbe extends Runtime {
  readonly name = 'shell-probe'
  readonly [LINE_EXECUTOR] = true as const
  runLine(
    command: string,
    stdin: Uint8Array | null,
    _env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    return Promise.resolve({
      stdout: enc.encode(command + ':' + cwd + dec.decode(stdin ?? new Uint8Array())),
      stderr: null,
      exitCode: 0,
    })
  }
}
class DenySecret implements Policy {
  preSession(ctx: SessionContext): Action | null {
    return ctx.key === 'SECRET' ? { kind: 'deny', reason: 'protected' } : null
  }
}

async function world(runtimes?: Runtime[]): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/data': new RAMResource(), '/secret': new RAMResource() },
    {
      mode: MountMode.EXEC,
      policies: [new DenySecret()],
      shellParserFactory: () => Promise.resolve(parser),
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
        this.read = binding.dispatch('read', '/data/file')
      }
    }
    const runtime = new EagerProbe()
    const data = new RAMResource()
    data.loadState({ type: 'ram', files: { '/file': enc.encode('ready') } })
    const ws = new Workspace({ '/data': data }, { runtimes: [runtime] })
    try {
      expect(runtime.prefixes).toEqual(['/data/', '/dev/'])
      expect(runtime.links).toEqual([])
      expect(required(runtime.context).cwd.virtual).toBe('/')
      expect(required(runtime.context).sessionView).not.toBeNull()
      expect(dec.decode((await runtime.read) as Uint8Array)).toBe('ready')
    } finally {
      await ws.close()
    }
  })

  it('declares capabilities and refuses unsupported kinds and languages', async () => {
    const language = new Probe(),
      native = new ShellProbe()
    const code = {
      kind: 'code',
      language: 'python',
      code: 'hello',
      args: [],
      env: {},
      stdin: null,
    } as const
    const shell = {
      kind: 'shell',
      line: 'echo hello',
      cwd: PathSpec.fromStrPath('/work'),
      stdin: enc.encode('!'),
      env: {},
    } as const
    expect(language.capabilities.languages).toEqual(['python'])
    expect(language.capabilities.reach).toBe('vfs')
    expect(language.capabilities.shell).toBe(false)
    expect(native.capabilities.shell).toBe(true)
    expect(native.capabilities.process).toBe(false)
    expect(language.capabilities.filesystem).toEqual([])
    expect(native.capabilities.filesystem).toEqual([])
    expect(dec.decode((await language.execute({ ...code, args: [] })).stdout)).toBe('hello')
    expect(dec.decode((await native.execute(shell)).stdout)).toBe('echo hello:/work!')
    await expect(language.execute(shell)).rejects.toBeInstanceOf(UnsupportedExecutionError)
    await expect(native.execute({ ...code, args: [] })).rejects.toBeInstanceOf(
      UnsupportedExecutionError,
    )
    await expect(language.execute({ ...code, args: [], language: 'js' })).rejects.toBeInstanceOf(
      UnsupportedExecutionError,
    )
    await expect(
      native.execute({
        kind: 'process',
        argv: ['echo', 'hello'],
        cwd: shell.cwd,
        env: {},
        stdin: null,
      }),
    ).rejects.toBeInstanceOf(UnsupportedExecutionError)
  })

  it('retains session permissions and gated writes after capture', async () => {
    const ws = await world()
    try {
      await ws.execute('echo private > /secret/a')
      ws.createSession('agent', { profile: { paths: { hide: ['/secret'] } } })
      const context = ws.runtimeContext('agent'),
        other = ws.runtimeContext()
      expect(required(context.ns.mounts).visibleDescendants('/')).not.toContain('/secret/')
      await expect(context.dispatch('read', '/secret/a')).rejects.toThrow()
      expect(dec.decode((await other.dispatch('read', '/secret/a')) as Uint8Array)).toBe(
        'private\n',
      )
      await required(context.sessionView).set('PUBLIC', 'agent')
      expect(required(context.sessionView).get('PUBLIC')).toBe('agent')
      expect(required(other.sessionView).get('PUBLIC')).toBeNull()
      expect(context.env.PUBLIC).toBeUndefined()
      await expect(required(context.sessionView).set('SECRET', 'no')).rejects.toThrow('protected')
      const reads = await Promise.all([
        context.scope.run(async () => {
          await Promise.resolve()
          return required(context.sessionView).get('PUBLIC')
        }),
        other.scope.run(async () => {
          await Promise.resolve()
          return required(other.sessionView).get('PUBLIC')
        }),
      ])
      expect(reads).toEqual(['agent', null])
    } finally {
      await ws.close()
    }
  })

  it('projects live mounts, namespace links, and attributes through the binding', async () => {
    const ws = await world()
    try {
      await ws.execute('echo shared > /data/a; chmod 600 /data/a')
      const context = ws.runtimeContext()
      await ws.execute('ln -s /data/a /data/link')
      expect(required(context.ns.links).resolve('/data/link')).toBe('/data/a')
      ws.addMount('/data/nested', new RAMResource(), MountMode.EXEC)
      expect(context.resolver.ownerOf('/data/nested/a')).toBe('/data/nested/')
      const vfs = new RuntimeVFS(context.dispatch, context.resolver)
      expect(dec.decode(await vfs.read('/data/link'))).toBe('shared\n')
      expect((await vfs.stat('/data/a')).mode & 0o777).toBe(0o600)
    } finally {
      await ws.close()
    }
  })

  it('refuses a foreign context or sharing an instance across workspaces', async () => {
    const runtime = new Probe()
    const first = await world([runtime]),
      second = await world()
    try {
      const request = {
        kind: 'code',
        language: 'python',
        code: 'ok',
        args: [],
        env: {},
        stdin: null,
      } as const
      expect(
        dec.decode(
          (await runtime.execute({ ...request, args: [] }, first.runtimeContext())).stdout,
        ),
      ).toBe('ok')
      await expect(
        runtime.execute({ ...request, args: [] }, second.runtimeContext()),
      ).rejects.toThrow('another binding')
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
    expect(runtime.capabilities.filesystem).toEqual(
      _name === 'monty'
        ? ['read', 'write', 'list']
        : _name === 'quickjs'
          ? ['read', 'write', 'list', 'stat']
          : ['read', 'write', 'list', 'stat', 'glob'],
    )
    const ws = await world([runtime])
    try {
      await ws.execute('echo shared > /data/file; ln -s /data/file /data/link')
      ws.createSession('one')
      ws.createSession('two')
      const calls: string[][] = [[], []]
      const results = await Promise.all(
        ['one', 'two'].map((session, index) => {
          const captured = ws.runtimeContext(session)
          const context: RuntimeContext = {
            ...captured,
            dispatch: (...args) => {
              required(calls[index]).push(`${args[0]}:${args[1]}`)
              return captured.dispatch(...args)
            },
          }
          return runtime.execute(
            {
              kind: 'code',
              language: runtime.language,
              code:
                runtime.language === 'js'
                  ? "const f = std.open('/data/link', 'r'); std.out.puts(f.readAsString()); f.close()"
                  : "print(open('/data/link').read(), end='')",
              args: [],
              env: {},
              stdin: null,
            },
            context,
          )
        }),
      )
      for (const result of results) {
        expect(result.exitCode, dec.decode(result.stderr ?? new Uint8Array())).toBe(0)
        expect(dec.decode(result.stdout)).toBe('shared\n')
      }
      for (const entries of calls)
        expect(entries.some((entry) => /^read:\/data\/(file|link)$/.test(entry))).toBe(true)
    } finally {
      await ws.close()
    }
  },
  60_000,
)

it('command execution supplies its active workspace context', async () => {
  const runtime = new Probe({ captures: ['python3'] })
  const ws = await world([runtime])
  try {
    ws.createSession('agent')
    await ws.execute('export PUBLIC=agent; cd /data', { sessionId: 'agent' })
    const result = await ws.execute('python3 -c hello', { sessionId: 'agent' })
    expect(dec.decode(result.stdout)).toBe('hello')
    const captured = required(runtime.contexts.at(-1))
    expect(captured.cwd.virtual).toBe('/data')
    expect(captured.env.PUBLIC).toBe('agent')
    expect(required(captured.sessionView).get('PUBLIC')).toBe('agent')
    await ws.execute('python3 -c other')
    expect(required(runtime.contexts.at(-1)).env.PUBLIC).toBeUndefined()
    expect(required(captured.sessionView).get('PUBLIC')).toBe('agent')
  } finally {
    await ws.close()
  }
})
