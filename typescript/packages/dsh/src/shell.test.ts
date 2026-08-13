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

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { Workspace } from '@struktoai/mirage-node'
import { MirageService } from './service.ts'
import { MirageShellExecutor } from './shell.ts'
import type { MirageShellConfig } from './shell.ts'

const workspaces: Workspace[] = []

async function attachShell(ws: Workspace, config: MirageShellConfig): Promise<MirageShellExecutor> {
  const ctx = new Context()
  await ctx.plugin(MirageService, { workspace: ws }).await()
  await ctx.plugin(MirageShellExecutor, config).await()
  return ctx.shell as MirageShellExecutor
}

async function makeShell(
  seed: Record<string, string> = {},
  config: MirageShellConfig = {},
): Promise<{ shell: MirageShellExecutor; ws: Workspace }> {
  const ws = new Workspace({ '/data': [new RAMResource(), MountMode.WRITE] })
  workspaces.push(ws)
  for (const [path, content] of Object.entries(seed)) {
    await ws.fs.writeFile(`/data/${path}`, content)
  }
  return { shell: await attachShell(ws, config), ws }
}

afterEach(async () => {
  while (workspaces.length > 0) await workspaces.pop()?.close()
})

describe('resolve', () => {
  it('applies defaults and caps the timeout', async () => {
    const { shell } = await makeShell({}, { defaultTimeoutMs: 5000, maxTimeoutMs: 8000 })
    const defaulted = shell.resolve({ command: 'true' })
    expect(defaulted.workdir).toBe('/')
    expect(defaulted.timeoutMs).toBe(5000)
    const capped = shell.resolve({ command: 'true', timeoutMs: 60_000 })
    expect(capped.timeoutMs).toBe(8000)
  })
})

describe('run', () => {
  it('executes a command against the mounted workspace', async () => {
    const { shell } = await makeShell({ 'a.txt': 'mounted content' })
    const result = await shell.run(shell.resolve({ command: 'cat /data/a.txt' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('mounted content')
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it('reports nonzero exits as results, with stderr', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(shell.resolve({ command: 'cat /data/nope' }))
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.text).toContain('No such file')
  })

  it('feeds stdin to the command', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(shell.resolve({ command: 'cat', stdin: 'from stdin' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('from stdin')
  })

  it('honors workdir and env', async () => {
    const { shell } = await makeShell({ 'a.txt': 'x' })
    const cwd = await shell.run(shell.resolve({ command: 'pwd', workdir: '/data' }))
    expect(cwd.stdout.text.trim()).toBe('/data')
    const env = await shell.run(
      shell.resolve({ command: 'echo "$GREETING"', env: { GREETING: 'salut' } }),
    )
    expect(env.stdout.text.trim()).toBe('salut')
  })

  it('caps stdout to the budget, keeping the tail', async () => {
    const { shell } = await makeShell()
    const spec = shell.resolve({ command: 'printf "%s" aaaaabbbbb', stdoutMaxBytes: 5 })
    const result = await shell.run(spec)
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text).toBe('bbbbb')
  })

  it('kills on timeout and reports the first cause', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(shell.resolve({ command: 'sleep 30', timeoutMs: 200 }))
    expect(result.timedOut).toBe(true)
    expect(result.aborted).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGTERM')
  })

  it('kills on caller abort and reports the first cause', async () => {
    const { shell } = await makeShell()
    const controller = new AbortController()
    const pending = shell.run(shell.resolve({ command: 'sleep 30', signal: controller.signal }))
    setTimeout(() => {
      controller.abort()
    }, 100)
    const result = await pending
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBeNull()
  })

  it('never dispatches when the signal is already aborted', async () => {
    const { shell, ws } = await makeShell()
    const controller = new AbortController()
    controller.abort()
    const result = await shell.run(
      shell.resolve({ command: 'echo ran > /data/out.txt', signal: controller.signal }),
    )
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(await ws.fs.exists('/data/out.txt')).toBe(false)
  })
})

describe('session isolation', () => {
  it('gives each run a clean slate by default', async () => {
    const { shell } = await makeShell()
    await shell.run(shell.resolve({ command: 'export FOO=leak; greet() { echo hi; }; cd /data' }))
    const probe = await shell.run(shell.resolve({ command: 'echo "[$FOO]"; pwd; type -t greet' }))
    expect(probe.stdout.text).toBe('[]\n/\n')
    expect(probe.exitCode).not.toBe(0)
  })

  it('stays isolated when a spec carries an empty workdir', async () => {
    const { shell } = await makeShell()
    await shell.run({ ...shell.resolve({ command: 'export FOO=leak; cd /data' }), workdir: '' })
    const probe = await shell.run({
      ...shell.resolve({ command: 'echo "[$FOO]"; pwd' }),
      workdir: '',
    })
    expect(probe.stdout.text).toBe('[]\n/\n')
  })

  it('keeps start() isolated on an empty workdir too', async () => {
    const { shell } = await makeShell()
    const proc = shell.start({ ...shell.resolve({ command: 'export BG=leak' }), workdir: '' })
    await proc.done
    const probe = await shell.run({ ...shell.resolve({ command: 'echo "[$BG]"' }), workdir: '' })
    expect(probe.stdout.text.trim()).toBe('[]')
  })
})

describe('session binding', () => {
  it('persists exports, cwd, and functions across runs', async () => {
    const { shell } = await makeShell({}, { sessionId: 's1' })
    const setup = await shell.run(
      shell.resolve({
        command: 'export GREETING=salut; greet() { echo "$GREETING from $PWD"; }; cd /data',
      }),
    )
    expect(setup.exitCode).toBe(0)
    const out = await shell.run(shell.resolve({ command: 'greet' }))
    expect(out.stdout.text.trim()).toBe('salut from /data')
  })

  it('keeps differently bound executors apart on one workspace', async () => {
    const ws = new Workspace({ '/data': [new RAMResource(), MountMode.WRITE] })
    workspaces.push(ws)
    const alpha = await attachShell(ws, { sessionId: 'alpha' })
    const beta = await attachShell(ws, { sessionId: 'beta' })
    await alpha.run(alpha.resolve({ command: 'export WHO=alpha' }))
    const cross = await beta.run(beta.resolve({ command: 'echo "[$WHO]"' }))
    expect(cross.stdout.text.trim()).toBe('[]')
    const back = await alpha.run(alpha.resolve({ command: 'echo "[$WHO]"' }))
    expect(back.stdout.text.trim()).toBe('[alpha]')
    const direct = await ws.execute('echo "[$WHO]"')
    expect(direct.stdoutText.trim()).toBe('[]')
  })

  it('adopts an existing session instead of recreating it', async () => {
    const ws = new Workspace({ '/data': [new RAMResource(), MountMode.WRITE] })
    workspaces.push(ws)
    ws.createSession('pre')
    await ws.execute('export SEED=planted', { sessionId: 'pre' })
    const shell = await attachShell(ws, { sessionId: 'pre' })
    const out = await shell.run(shell.resolve({ command: 'echo "$SEED"' }))
    expect(out.stdout.text.trim()).toBe('planted')
  })

  it('seeds a created session at the configured workdir', async () => {
    const { shell } = await makeShell({}, { sessionId: 'seeded', workdir: '/data' })
    const out = await shell.run(shell.resolve({ command: 'pwd; echo "$PWD"' }))
    expect(out.stdout.text).toBe('/data\n/data\n')
  })

  it('treats an explicit workdir as a one-call subshell', async () => {
    const { shell } = await makeShell({}, { sessionId: 's2' })
    await shell.run(shell.resolve({ command: 'cd /data' }))
    const sub = await shell.run(shell.resolve({ command: 'pwd', workdir: '/' }))
    expect(sub.stdout.text.trim()).toBe('/')
    const back = await shell.run(shell.resolve({ command: 'pwd' }))
    expect(back.stdout.text.trim()).toBe('/data')
  })

  it('keeps a per-call env override out of the session', async () => {
    const { shell } = await makeShell({}, { sessionId: 's3' })
    const once = await shell.run(
      shell.resolve({ command: 'echo "[$TOKEN]"', env: { TOKEN: 'once' } }),
    )
    expect(once.stdout.text.trim()).toBe('[once]')
    const later = await shell.run(shell.resolve({ command: 'echo "[$TOKEN]"' }))
    expect(later.stdout.text.trim()).toBe('[]')
  })

  it('binds start() to the session too', async () => {
    const { shell } = await makeShell({}, { sessionId: 's4' })
    const proc = shell.start(shell.resolve({ command: 'export BG=yes' }))
    await proc.done
    const out = await shell.run(shell.resolve({ command: 'echo "$BG"' }))
    expect(out.stdout.text.trim()).toBe('yes')
  })
})

describe('start', () => {
  it('runs in the background and delivers buffered output once', async () => {
    const { shell } = await makeShell({ 'a.txt': 'background read' })
    const proc = shell.start(shell.resolve({ command: 'cat /data/a.txt' }))
    expect(proc.status).toBe('running')
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.exitCode).toBe(0)
    const first = proc.readOutput()
    expect(first.delta).toBe('background read')
    expect(proc.readOutput().delta).toBe('')
  })

  it('kill aborts a running command and is idempotent about completion', async () => {
    const { shell } = await makeShell()
    const proc = shell.start(shell.resolve({ command: 'sleep 30' }))
    expect(proc.kill()).toBe(true)
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.kill()).toBe(false)
  })

  it('kill returns false once completed', async () => {
    const { shell } = await makeShell()
    const proc = shell.start(shell.resolve({ command: 'true' }))
    await proc.done
    expect(proc.kill()).toBe(false)
  })

  it('never dispatches when the signal is already aborted', async () => {
    const { shell, ws } = await makeShell()
    const controller = new AbortController()
    controller.abort()
    const proc = shell.start(
      shell.resolve({ command: 'echo ran > /data/out.txt', signal: controller.signal }),
    )
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.exitCode).toBeNull()
    expect(await ws.fs.exists('/data/out.txt')).toBe(false)
  })
})
