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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ShellExecSpec, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { AuthMode, buildApp } from '@struktoai/mirage-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MirageService } from '../service.ts'
import type { MirageShellConfig } from '../shell.ts'
import { MirageShellExecutor } from '../shell.ts'
import { MirageClient, type MirageRemote } from './client.ts'
import { RemoteMirageService } from './service.ts'

const RAM = { config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } }
const TOKEN = 'dsh-remote-shell'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let root: string
let app: ReturnType<typeof buildApp>
let url: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-remote-shell-'))
  app = buildApp({
    stateRoot: join(root, 'state'),
    authConfig: { mode: AuthMode.Local, localToken: TOKEN },
  })
  url = await app.listen({ port: 0, host: '127.0.0.1' })
})

afterAll(async () => {
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

async function workspace(): Promise<MirageRemote> {
  const made = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    payload: RAM,
    headers: AUTH,
  })
  return { url, workspace: made.json<{ id: string }>().id, token: TOKEN }
}

async function remoteShell(
  remote: MirageRemote,
  config: MirageShellConfig = {},
  service: typeof MirageService | typeof RemoteMirageService = RemoteMirageService,
): Promise<MirageShellExecutor> {
  const ctx = new Context()
  await ctx.plugin(service, { remote }).await()
  await ctx.plugin(MirageShellExecutor, config).await()
  return ctx.shell as MirageShellExecutor
}

async function run(
  shell: ShellExecutor,
  request: Parameters<ShellExecutor['resolve']>[0],
): Promise<ShellRunResult> {
  const spec: ShellExecSpec = shell.resolve(request)
  return (await shell.execute(spec)).result()
}

describe('MirageShellExecutor on a remote workspace', () => {
  it('runs a line on the server and returns its output', async () => {
    const shell = await remoteShell(await workspace())
    const result = await run(shell, { command: 'echo hello; echo oops >&2; exit 2' })
    expect(result.exitCode).toBe(2)
    expect(result.stdout.text).toBe('hello\n')
    expect(result.stderr.text).toBe('oops\n')
    expect(result.timedOut).toBe(false)
  })

  it('keeps nothing between unbound calls', async () => {
    const shell = await remoteShell(await workspace())
    await run(shell, { command: 'mkdir -p /work && cd /work && export TOKEN=abc' })
    const result = await run(shell, { command: 'pwd; echo "[$TOKEN]"' })
    expect(result.stdout.text).toBe('/\n[]\n')
  })

  it('keeps cwd and exports in a bound session, and follows dsh workdirs', async () => {
    const remote = await workspace()
    const shell = await remoteShell(remote, { sessionId: 'agent' })
    await run(shell, { command: 'mkdir -p /work /other && cd /work && export TOKEN=abc' })
    const kept = await run(shell, { command: 'pwd; echo $TOKEN' })
    expect(kept.stdout.text).toBe('/work\nabc\n')
    const moved = await run(shell, { command: 'pwd', workdir: '/other' })
    expect(moved.stdout.text).toBe('/other\n')
    const host = await run(shell, { command: 'pwd', workdir: '/Users/somebody/host-project' })
    expect(host.stdout.text).toBe('/other\n')
    const sessions = await new MirageClient(remote).sessions()
    expect(sessions.some((s) => s.sessionId === 'agent')).toBe(true)
  })

  it('runs a per-call env for that call alone, even in a bound session', async () => {
    const shell = await remoteShell(await workspace(), { sessionId: 'agent' })
    const once = await run(shell, { command: 'echo "$GREETING"', env: { GREETING: "it's here" } })
    expect(once.stdout.text).toBe("it's here\n")
    const after = await run(shell, { command: 'echo "[$GREETING]"' })
    expect(after.stdout.text).toBe('[]\n')
  })

  it('seeds the managed DSH_ snapshot into a bound session and drops stale keys', async () => {
    const shell = await remoteShell(await workspace(), { sessionId: 'agent' })
    await run(shell, { command: 'true', dshEnv: { DSH_ONE: '1', DSH_TWO: '2' } })
    await run(shell, { command: 'export DSH_MINE=kept' })
    const next = await run(shell, {
      command: 'echo "$DSH_ONE.$DSH_TWO.$DSH_MINE"',
      dshEnv: { DSH_ONE: 'uno' },
    })
    expect(next.stdout.text).toBe('uno..kept\n')
  })

  it('reports line numbers as the caller wrote them', async () => {
    const shell = await remoteShell(await workspace())
    const result = await run(shell, { command: 'cat /missing.txt', dshEnv: { DSH_SESSION: 's-1' } })
    expect(result.stderr.text).toContain('/missing.txt')
    const scripted = await run(shell, { command: 'true\nfalse_command_xyz', env: { A: '1' } })
    expect(scripted.stderr.text).toContain('line 2')
  })

  it('refuses an environment name the shell would read as a command', async () => {
    const shell = await remoteShell(await workspace())
    const bad = run(shell, { command: 'true', env: { 'X=1; touch /pwned; #': 'v' } })
    await expect(bad).rejects.toThrow('is not a shell variable name')
  })

  it('runs a call beside a busy bound session without waiting, carrying its snapshot', async () => {
    const shell = await remoteShell(await workspace(), { sessionId: 'agent' })
    const busy = await shell.execute(shell.resolve({ command: 'sleep 5', dshEnv: { DSH_N: '1' } }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    const started = Date.now()
    const quick = await run(shell, {
      command: 'echo $DSH_N',
      dshEnv: { DSH_N: '2' },
      timeoutMs: 3000,
    })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(quick.timedOut).toBe(false)
    expect(quick.stdout.text).toBe('2\n')
    busy.kill()
    await busy.done
  })

  it('unsets in a fork beside a busy session the facts its snapshot drops', async () => {
    const shell = await remoteShell(await workspace(), { sessionId: 'agent' })
    const busy = await shell.execute(
      shell.resolve({ command: 'sleep 5', dshEnv: { DSH_A: '1', DSH_B: 'old' } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    const quick = await run(shell, {
      command: 'echo "${DSH_B-gone}" $DSH_A',
      dshEnv: { DSH_A: '2' },
      timeoutMs: 3000,
    })
    expect(quick.stdout.text).toBe('gone 2\n')
    busy.kill()
    await busy.done
  })

  it('forks with its snapshot when the busy line ends between preparing and launching', async () => {
    const shell = await remoteShell(await workspace(), { sessionId: 'agent' })
    const busy = await shell.execute(shell.resolve({ command: 'sleep 5', dshEnv: { DSH_N: '1' } }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    const target = shell as unknown as { prepare(spec: ShellExecSpec): Promise<unknown> }
    const prepare = target.prepare.bind(shell)
    vi.spyOn(target, 'prepare').mockImplementation(async (spec) => {
      const prepared = await prepare(spec)
      busy.kill()
      await busy.done
      return prepared
    })
    const quick = await run(shell, {
      command: 'echo $DSH_N',
      dshEnv: { DSH_N: '2' },
      timeoutMs: 3000,
    })
    expect(quick.stdout.text).toBe('2\n')
  })

  it('adopts a session another client created after the listing', async () => {
    const remote = await workspace()
    await new MirageClient(remote).createSession('agent')
    const stale: typeof fetch = (input, init) => {
      const target = String(input instanceof Request ? input.url : input)
      if ((init?.method ?? 'GET') === 'GET' && new URL(target).pathname.endsWith('/sessions')) {
        return Promise.resolve(Response.json({ items: [] }))
      }
      return fetch(input, init)
    }
    const shell = await remoteShell({ ...remote, fetch: stale }, { sessionId: 'agent' })
    const result = await run(shell, { command: 'echo adopted' })
    expect(result.stdout.text).toBe('adopted\n')
  })

  it('feeds stdin', async () => {
    const shell = await remoteShell(await workspace())
    const result = await run(shell, { command: 'cat', stdin: 'fed through\n' })
    expect(result.stdout.text).toBe('fed through\n')
  })

  it('kills a line at its timeout', async () => {
    const shell = await remoteShell(await workspace())
    const result = await run(shell, { command: 'sleep 30', timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('makes no sandbox claim for a remote world', async () => {
    const shell = await remoteShell(await workspace())
    expect(shell.sandboxMode).toBeUndefined()
    const result = await run(shell, { command: 'true' })
    expect(result.sandbox).toBeUndefined()
  })

  it('streams a background line through readOutput', async () => {
    const shell = await remoteShell(await workspace())
    const execution = await shell.execute(
      shell.resolve({ command: 'echo first; sleep 0.3; echo second' }),
    )
    await execution.done
    expect(execution.readOutput().delta).toBe('first\nsecond\n')
    expect(execution.exitCode).toBe(0)
  })

  it('takes the same remote config through the root MirageService', async () => {
    const shell = await remoteShell(await workspace(), {}, MirageService)
    const result = await run(shell, { command: 'echo root' })
    expect(result.stdout.text).toBe('root\n')
  })
})
