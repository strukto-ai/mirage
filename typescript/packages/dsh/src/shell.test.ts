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
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { LocalRuntime, Workspace, parseSessionProfile } from '@struktoai/mirage-node'
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
  const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] })
  workspaces.push(ws)
  for (const [path, content] of Object.entries(seed)) {
    await ws.vfs.writeFile(`/data/${path}`, content)
  }
  return { shell: await attachShell(ws, config), ws }
}

afterEach(async () => {
  while (workspaces.length > 0) await workspaces.pop()?.close()
})

describe('resolve', () => {
  it('declares workspace-write confinement', async () => {
    const { shell } = await makeShell()
    expect(shell.sandboxMode).toBe('workspace-write')
  })

  it('claims no confinement once a runtime executes beyond the workspace', async () => {
    const { shell, ws } = await makeShell()
    ws.addRuntime(new LocalRuntime({ captures: ['python'] }))
    expect(shell.sandboxMode).toBeUndefined()
  })

  it('applies defaults and caps the timeout', async () => {
    const { shell } = await makeShell({}, { defaultTimeoutMs: 5000, maxTimeoutMs: 8000 })
    const defaulted = shell.resolve({ command: 'true' })
    expect(defaulted.workdir).toBe('/')
    expect(defaulted.timeoutMs).toBe(5000)
    const capped = shell.resolve({ command: 'true', timeoutMs: 60_000 })
    expect(capped.timeoutMs).toBe(8000)
  })
})

describe('workdir', () => {
  const HOST_WORKDIR = '/Users/somebody/host-project'

  it('ignores a workdir that names nothing in this world', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(shell.resolve({ command: 'pwd', workdir: HOST_WORKDIR }))
    expect(result.stdout.text.trim()).toBe('/')
  })

  it('leaves relative paths reachable when the harness sends a host workdir', async () => {
    const { shell } = await makeShell({ 'a.txt': 'x' }, { workdir: '/data' })
    const result = await shell.run(shell.resolve({ command: 'ls .', workdir: HOST_WORKDIR }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text.trim()).toBe('a.txt')
  })

  it('still honors a workdir inside the world', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(shell.resolve({ command: 'pwd', workdir: '/data' }))
    expect(result.stdout.text.trim()).toBe('/data')
  })

  it('keeps a bound session persistent when the harness sends a host workdir', async () => {
    const { shell } = await makeShell({}, { sessionId: 'agent', workdir: '/data' })
    await shell.run(shell.resolve({ command: 'export MARK=one; cd /', workdir: HOST_WORKDIR }))
    const echoed = await shell.run(
      shell.resolve({ command: 'echo "[$MARK][$(pwd)]"', workdir: HOST_WORKDIR }),
    )
    expect(echoed.stdout.text.trim()).toBe('[one][/]')
  })

  it('keeps a bound session persistent through the managed env dsh sends every call', async () => {
    const { shell } = await makeShell({}, { sessionId: 'agent', workdir: '/data' })
    const dshEnv = { DSH_HOME: '/home/.dsh', DSH_SHELL: '1' } as const
    await shell.run(shell.resolve({ command: 'export MARK=one; cd /', dshEnv }))
    const echoed = await shell.run(
      shell.resolve({ command: 'echo "[$MARK][$(pwd)][$DSH_HOME]"', dshEnv }),
    )
    expect(echoed.stdout.text.trim()).toBe('[one][/][/home/.dsh]')
  })

  it('drops a managed fact the newest snapshot omits', async () => {
    const { shell } = await makeShell({}, { sessionId: 'agent' })
    await shell.run(
      shell.resolve({ command: 'true', dshEnv: { DSH_HOME: '/a', DSH_SESSION_ID: 'x' } }),
    )
    const echoed = await shell.run(
      shell.resolve({ command: 'echo "[$DSH_SESSION_ID][$DSH_HOME]"', dshEnv: { DSH_HOME: '/a' } }),
    )
    expect(echoed.stdout.text.trim()).toBe('[][/a]')
  })

  it('still forks for a per-call env override on a bound session', async () => {
    const { shell } = await makeShell({}, { sessionId: 'agent' })
    await shell.run(shell.resolve({ command: 'export KEEP=yes' }))
    const forked = await shell.run(
      shell.resolve({ command: 'echo "[$ONCE][$KEEP]"', env: { ONCE: 'x' } }),
    )
    expect(forked.stdout.text.trim()).toBe('[x][yes]')
    const after = await shell.run(shell.resolve({ command: 'echo "[$ONCE]"' }))
    expect(after.stdout.text.trim()).toBe('[]')
  })

  it('ignores a host workdir for a background command too', async () => {
    const { shell } = await makeShell()
    const proc = shell.start(shell.resolve({ command: 'pwd', workdir: HOST_WORKDIR }))
    await proc.done
    expect(proc.readOutput().delta.trim()).toBe('/')
  })
})

describe('sandbox policy', () => {
  const READ_ONLY = { mode: 'read-only', workspaceRoot: '/Users/somebody/host-project' } as const
  const WORKSPACE_WRITE = { mode: 'workspace-write', workspaceRoot: '/Users/somebody' } as const

  it('refuses a write under a read-only policy', async () => {
    const { shell, ws } = await makeShell()
    const result = await shell.run(
      shell.resolve({ command: 'echo written > /data/x.txt', sandboxPolicy: READ_ONLY }),
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox?.mode).toBe('read-only')
    expect(result.sandbox?.denied).toBe(true)
    expect(await ws.vfs.exists('/data/x.txt')).toBe(false)
  })

  it('refuses a mutating command under a read-only policy', async () => {
    const { shell } = await makeShell({ 'a.txt': 'seed' })
    const result = await shell.run(
      shell.resolve({ command: 'rm /data/a.txt', sandboxPolicy: READ_ONLY }),
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox?.denied).toBe(true)
  })

  it('still reads under a read-only policy', async () => {
    const { shell } = await makeShell({ 'a.txt': 'visible' })
    const result = await shell.run(
      shell.resolve({ command: 'cat /data/a.txt', sandboxPolicy: READ_ONLY }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('visible')
    expect(result.sandbox?.denied).toBe(false)
  })

  it('keeps the null sink writable under a read-only policy', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(
      shell.resolve({ command: 'echo noise > /dev/null', sandboxPolicy: READ_ONLY }),
    )
    expect(result.exitCode).toBe(0)
  })

  it('allows a write under a workspace-write policy and stamps that mode', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(
      shell.resolve({
        command: 'echo written > /data/x.txt && cat /data/x.txt',
        sandboxPolicy: WORKSPACE_WRITE,
      }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text.trim()).toBe('written')
    expect(result.sandbox?.mode).toBe('workspace-write')
  })

  it('stamps the executor default when the caller supplies no policy', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(shell.resolve({ command: 'true' }))
    expect(result.sandbox?.mode).toBe('workspace-write')
  })

  it('makes no sandbox claim once a runtime executes beyond the workspace', async () => {
    const { shell, ws } = await makeShell()
    ws.addRuntime(new LocalRuntime({ captures: ['python'] }))
    const result = await shell.run(
      shell.resolve({ command: 'echo written > /data/x.txt', sandboxPolicy: READ_ONLY }),
    )
    expect(result.sandbox).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })

  it('binds a background command to the policy too', async () => {
    const { shell, ws } = await makeShell()
    const proc = shell.start(
      shell.resolve({ command: 'echo written > /data/bg.txt', sandboxPolicy: READ_ONLY }),
    )
    await proc.done
    expect(proc.exitCode).not.toBe(0)
    expect(proc.sandbox?.mode).toBe('read-only')
    expect(await ws.vfs.exists('/data/bg.txt')).toBe(false)
  })

  it('narrows a confined session without widening it', async () => {
    const ws = new Workspace({
      '/allowed': [new RAMVFS(), MountMode.WRITE],
      '/secret': [new RAMVFS(), MountMode.WRITE],
    })
    workspaces.push(ws)
    await ws.vfs.writeFile('/allowed/a.txt', 'granted')
    await ws.vfs.writeFile('/secret/a.txt', 'classified')
    // Exclusion is a hide: a mount the profile does not name keeps its own
    // mode, so confining a session to /allowed means hiding /secret.
    ws.createSession('confined', {
      mounts: { '/allowed': 'exec' },
      permissions: { paths: { hide: ['/secret'] } },
    })
    const shell = await attachShell(ws, { sessionId: 'confined' })
    const granted = await shell.run(
      shell.resolve({ command: 'cat /allowed/a.txt', sandboxPolicy: READ_ONLY }),
    )
    expect(granted.exitCode).toBe(0)
    expect(granted.stdout.text).toBe('granted')
    const secret = await shell.run(
      shell.resolve({ command: 'cat /secret/a.txt', sandboxPolicy: READ_ONLY }),
    )
    expect(secret.exitCode).not.toBe(0)
    expect(secret.stdout.text).not.toContain('classified')
  })

  it('keeps an unbound read-only call one-shot', async () => {
    const { shell } = await makeShell()
    const leak = shell.resolve({
      command: 'cd /data && export MARK=leaked',
      workdir: '/Users/somebody/host-project',
      sandboxPolicy: READ_ONLY,
    })
    await shell.run(leak)
    const next = await shell.run(
      shell.resolve({
        command: 'pwd; echo "[$MARK]"',
        workdir: '/Users/somebody/host-project',
        sandboxPolicy: READ_ONLY,
      }),
    )
    expect(next.stdout.text.trim().split('\n')).toEqual(['/', '[]'])
  })

  it("carries the bound session's command rules into the read-only twin", async () => {
    const ws = new Workspace(
      { '/data': [new RAMVFS(), MountMode.WRITE] },
      {
        profiles: {
          scoped: parseSessionProfile(
            {
              commands: {
                allow: ['cat', 'ls', 'echo'],
                deny: [{ reason: 'no notes', paths: ['/data/notes/*'] }],
              },
            },
            'profile scoped',
          ),
        },
      },
    )
    workspaces.push(ws)
    await ws.vfs.mkdir('/data/notes')
    await ws.vfs.writeFile('/data/notes/a.txt', 'private')
    ws.createSession('agent', { profile: 'scoped' })
    const shell = await attachShell(ws, { sessionId: 'agent' })
    // The profile refuses this read, and read-only is not a way around it:
    // every mount being `read` says nothing about a rule on a path.
    const denied = await shell.run(
      shell.resolve({ command: 'cat /data/notes/a.txt', sandboxPolicy: READ_ONLY }),
    )
    expect(denied.exitCode).not.toBe(0)
    expect(denied.stderr.text).toContain('no notes')
    // A word the profile never installed is still not a command here.
    const missing = await shell.run(
      shell.resolve({ command: 'sort /data/notes/a.txt', sandboxPolicy: READ_ONLY }),
    )
    expect(missing.stderr.text).toContain('command not found')
  })

  it('keeps a bound session out of the read-only twin it narrowed into', async () => {
    const { shell } = await makeShell({}, { sessionId: 'agent' })
    await shell.run(shell.resolve({ command: 'export MARK=writable' }))
    const confined = await shell.run(
      shell.resolve({ command: 'echo "[$MARK]"', sandboxPolicy: READ_ONLY }),
    )
    expect(confined.stdout.text.trim()).toBe('[]')
    const back = await shell.run(shell.resolve({ command: 'echo "[$MARK]"' }))
    expect(back.stdout.text.trim()).toBe('[writable]')
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
    expect(await ws.vfs.exists('/data/out.txt')).toBe(false)
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
    const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] })
    workspaces.push(ws)
    const alpha = await attachShell(ws, { sessionId: 'alpha' })
    const beta = await attachShell(ws, { sessionId: 'beta' })
    await alpha.run(alpha.resolve({ command: 'export WHO=alpha' }))
    const cross = await beta.run(beta.resolve({ command: 'echo "[$WHO]"' }))
    expect(cross.stdout.text.trim()).toBe('[]')
    const back = await alpha.run(alpha.resolve({ command: 'echo "[$WHO]"' }))
    expect(back.stdout.text.trim()).toBe('[alpha]')
    const direct = await ws.shell('echo "[$WHO]"')
    expect(direct.stdoutText.trim()).toBe('[]')
  })

  it('adopts an existing session instead of recreating it', async () => {
    const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] })
    workspaces.push(ws)
    ws.createSession('pre')
    await ws.shell('export SEED=planted', { sessionId: 'pre' })
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
    expect(await ws.vfs.exists('/data/out.txt')).toBe(false)
  })
})

describe('streaming', () => {
  it('delivers a compound line incrementally, before it finishes', async () => {
    const { shell } = await makeShell()
    const proc = shell.start(shell.resolve({ command: 'echo first; sleep 0.5; echo second' }))
    let acc = ''
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !acc.includes('first')) {
      acc += proc.readOutput().delta
      if (!acc.includes('first')) await new Promise((r) => setTimeout(r, 15))
    }
    expect(acc).toContain('first')
    // The sleep is still in flight, so the second statement has not run.
    expect(acc).not.toContain('second')
    expect(proc.status).toBe('running')
    await proc.done
    acc += proc.readOutput().delta
    expect(acc).toContain('second')
  })

  it('interleaves stdout and stderr in order, stderr marked', async () => {
    const { shell } = await makeShell()
    const proc = shell.start(shell.resolve({ command: 'echo out1; echo err1 >&2; echo out2' }))
    await proc.done
    const delta = proc.readOutput().delta
    expect(delta).toContain('--- stderr ---')
    expect(delta.indexOf('out1')).toBeLessThan(delta.indexOf('err1'))
    expect(delta.indexOf('err1')).toBeLessThan(delta.indexOf('out2'))
  })

  it('caps the unread backlog and flags lossy, keeping the tail', async () => {
    const { shell } = await makeShell({}, { stdoutMaxBytes: 12 })
    const proc = shell.start(
      shell.resolve({ command: 'echo aaaa; echo bbbb; echo cccc; echo dddd' }),
    )
    await proc.done
    const out = proc.readOutput()
    expect(out.lossy).toBe(true)
    expect(out.delta).toContain('dddd')
    expect(out.delta).not.toContain('aaaa')
    expect(new TextEncoder().encode(out.delta).byteLength).toBeLessThanOrEqual(12)
  })

  it('delivers the output of a line that never reached the command tree', async () => {
    const { shell } = await makeShell()
    // The syntax gate answers before the walk that streams, so this
    // arrives only because the executor drains a buffered result into
    // the console.
    const proc = shell.start(shell.resolve({ command: 'case x' }))
    await proc.done
    expect(proc.exitCode).toBe(2)
    expect(proc.readOutput().delta).toContain('syntax error')
  })
})

describe('spill', () => {
  it('does not spill when no directory is configured', async () => {
    const { shell } = await makeShell({}, { stdoutMaxBytes: 12 })
    const proc = shell.start(shell.resolve({ command: 'echo aaaa; echo bbbb; echo cccc' }))
    await proc.done
    const out = proc.readOutput()
    expect(out.lossy).toBe(true)
    expect(out.stdoutSpillPath).toBeUndefined()
  })

  it('spills the full stdout to a readable workspace file when the delta overruns', async () => {
    const { shell, ws } = await makeShell({}, { stdoutMaxBytes: 12, spillDir: '/data/spill' })
    const proc = shell.start(
      shell.resolve({ command: 'echo aaaa; echo bbbb; echo cccc; echo dddd' }),
    )
    await proc.done
    const out = proc.readOutput()
    expect(out.lossy).toBe(true)
    const stdoutPath = out.stdoutSpillPath
    if (stdoutPath === undefined) throw new Error('expected a stdout spill path')
    // The delta kept only the tail; the spill file has the whole stream.
    expect(out.delta).not.toContain('aaaa')
    const full = await ws.vfs.readFileText(stdoutPath)
    expect(full).toContain('aaaa')
    expect(full).toContain('dddd')
  })

  it('spills stdout and stderr to separate files', async () => {
    const { shell, ws } = await makeShell({}, { stdoutMaxBytes: 12, spillDir: '/data/spill' })
    const proc = shell.start(
      shell.resolve({ command: 'echo out1; echo err1 >&2; echo out2; echo out3' }),
    )
    await proc.done
    const out = proc.readOutput()
    const stdoutPath = out.stdoutSpillPath
    const stderrPath = out.stderrSpillPath
    if (stdoutPath === undefined) throw new Error('expected a stdout spill path')
    if (stderrPath === undefined) throw new Error('expected a stderr spill path')
    expect(await ws.vfs.readFileText(stdoutPath)).toContain('out1')
    expect(await ws.vfs.readFileText(stderrPath)).toContain('err1')
  })

  it('spills both commands when two overrun into a missing directory at once', async () => {
    const { shell, ws } = await makeShell({}, { stdoutMaxBytes: 12, spillDir: '/data/spill' })
    const line = 'echo aaaa; echo bbbb; echo cccc; echo dddd'
    const first = shell.start(shell.resolve({ command: line }))
    const second = shell.start(shell.resolve({ command: line }))
    await Promise.all([first.done, second.done])
    const paths = [first.readOutput().stdoutSpillPath, second.readOutput().stdoutSpillPath]
    // Whichever loses the mkdir race still spills, and to its own file.
    expect(paths[0]).toBeDefined()
    expect(paths[1]).toBeDefined()
    expect(paths[0]).not.toBe(paths[1])
    for (const path of paths) {
      if (path === undefined) throw new Error('expected a stdout spill path')
      expect(await ws.vfs.readFileText(path)).toContain('aaaa')
    }
  })

  it('creates a nested spill directory', async () => {
    const { shell, ws } = await makeShell({}, { stdoutMaxBytes: 12, spillDir: '/data/runs/spill' })
    const proc = shell.start(shell.resolve({ command: 'echo aaaa; echo bbbb; echo cccc' }))
    await proc.done
    const path = proc.readOutput().stdoutSpillPath
    if (path === undefined) throw new Error('expected a stdout spill path')
    expect(path.startsWith('/data/runs/spill/')).toBe(true)
    expect(await ws.vfs.readFileText(path)).toContain('aaaa')
  })
})

describe('sandbox facts', () => {
  it('stamps a full-enforcement workspace-write sandbox on a run result', async () => {
    const { shell } = await makeShell({ 'a.txt': 'x' })
    const result = await shell.run(shell.resolve({ command: 'cat /data/a.txt' }))
    expect(result.sandbox).toEqual({
      mode: 'workspace-write',
      denied: false,
      enforcement: 'full',
      runnerFailed: false,
    })
  })

  it('reports the sandbox independently of exit status', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(shell.resolve({ command: 'cat /data/nope' }))
    expect(result.exitCode).not.toBe(0)
    expect(result.sandbox?.mode).toBe('workspace-write')
    expect(result.sandbox?.denied).toBe(false)
  })

  it('omits the sandbox once a runtime executes beyond the workspace', async () => {
    const { shell, ws } = await makeShell()
    ws.addRuntime(new LocalRuntime({ captures: ['python'] }))
    const result = await shell.run(shell.resolve({ command: 'true' }))
    expect(result.sandbox).toBeUndefined()
  })

  it('stamps the sandbox on a settled background process', async () => {
    const { shell } = await makeShell({ 'a.txt': 'bg' })
    const proc = shell.start(shell.resolve({ command: 'cat /data/a.txt' }))
    expect(proc.sandbox).toBeUndefined()
    await proc.done
    expect(proc.sandbox).toEqual({
      mode: 'workspace-write',
      denied: false,
      enforcement: 'full',
      runnerFailed: false,
    })
  })
})

describe('foreground output fidelity', () => {
  it('returns the output a timed-out command already produced', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(
      shell.resolve({ command: 'echo early-output; sleep 30', timeoutMs: 300 }),
    )
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.stdout.text).toContain('early-output')
  })

  it('returns the output an aborted command already produced', async () => {
    const { shell } = await makeShell()
    const controller = new AbortController()
    const pending = shell.run(
      shell.resolve({ command: 'echo before-abort; sleep 30', signal: controller.signal }),
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    controller.abort()
    const result = await pending
    expect(result.aborted).toBe(true)
    expect(result.stdout.text).toContain('before-abort')
  })

  it('keeps stderr of a killed command too', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(
      shell.resolve({ command: 'cat /data/nope; sleep 30', timeoutMs: 400 }),
    )
    expect(result.timedOut).toBe(true)
    expect(result.stderr.text).toContain('No such file')
  })

  it('spills a truncated foreground run to the workspace', async () => {
    const { shell, ws } = await makeShell({}, { spillDir: '/data/spill' })
    const result = await shell.run(
      shell.resolve({ command: 'printf "%s" aaaaabbbbb', stdoutMaxBytes: 5 }),
    )
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text).toBe('bbbbb')
    const path = result.stdout.spillPath
    if (path === undefined) throw new Error('expected a spill path')
    expect(await ws.vfs.readFileText(path)).toBe('aaaaabbbbb')
  })

  it('keeps a foreground stream larger than any console retention budget', async () => {
    const { shell, ws } = await makeShell(
      { 'big.txt': 'x'.repeat(4000) },
      { stdoutMaxBytes: 64, stderrMaxBytes: 64, spillDir: '/data/spill' },
    )
    const result = await shell.run(shell.resolve({ command: 'cat /data/big.txt' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text).toBe('x'.repeat(64))
    const path = result.stdout.spillPath
    if (path === undefined) throw new Error('expected a spill path')
    expect(await ws.vfs.readFileText(path)).toBe('x'.repeat(4000))
  })

  it('leaves spillPath unset when nothing was truncated', async () => {
    const { shell } = await makeShell({}, { spillDir: '/data/spill' })
    const result = await shell.run(shell.resolve({ command: 'echo small' }))
    expect(result.stdout.truncated).toBe(false)
    expect(result.stdout.spillPath).toBeUndefined()
  })

  it('leaves spillPath unset when no spill directory is configured', async () => {
    const { shell } = await makeShell()
    const result = await shell.run(
      shell.resolve({ command: 'printf "%s" aaaaabbbbb', stdoutMaxBytes: 5 }),
    )
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.spillPath).toBeUndefined()
  })

  it('retains a large configured budget instead of a fixed constant', async () => {
    const { shell } = await makeShell({}, { stdoutMaxBytes: 2_000_000 })
    const proc = shell.start(shell.resolve({ command: 'printf "%0.sx" $(seq 1 300000)' }))
    await proc.done
    const read = proc.readOutput()
    expect(read.lossy).toBe(false)
    expect(read.delta.length).toBe(300_000)
  })
})

describe('background delta bounding', () => {
  it('caps the delta at the budget, keeping the tail', async () => {
    const { shell } = await makeShell()
    const proc = shell.start(
      shell.resolve({ command: 'printf "%s" abcdefghij', stdoutMaxBytes: 4 }),
    )
    await proc.done
    const read = proc.readOutput()
    expect(read.delta).toBe('ghij')
    expect(read.lossy).toBe(true)
  })

  it('never splits a multi-byte character across the cap', async () => {
    const { shell } = await makeShell()
    // "aaaé" is five bytes; the last three are "a" plus the two-byte "é",
    // so the cap lands on a character boundary rather than half of one.
    const proc = shell.start(shell.resolve({ command: 'printf "%s" aaaé', stdoutMaxBytes: 3 }))
    await proc.done
    expect(proc.readOutput().delta).toBe('aé')
  })

  it('re-aligns when the cap lands mid-character', async () => {
    const { shell } = await makeShell()
    // Budget 3 over "aaéé" (six bytes) would start inside the second "é",
    // so the leading continuation byte is dropped rather than decoded as
    // a replacement character.
    const proc = shell.start(shell.resolve({ command: 'printf "%s" aaéé', stdoutMaxBytes: 3 }))
    await proc.done
    expect(proc.readOutput().delta).toBe('é')
  })

  it('marks a stderr run once and keeps both streams in order', async () => {
    const { shell } = await makeShell()
    const proc = shell.start(shell.resolve({ command: 'echo out; cat /data/nope; echo out2' }))
    await proc.done
    const delta = proc.readOutput().delta
    expect(delta).toContain('out')
    expect(delta).toContain('--- stderr ---')
    expect(delta).toContain('out2')
    expect(delta.split('--- stderr ---').length - 1).toBe(1)
  })

  it('drains consuming, so a second read returns nothing new', async () => {
    const { shell } = await makeShell()
    const proc = shell.start(shell.resolve({ command: 'echo once' }))
    await proc.done
    expect(proc.readOutput().delta.trim()).toBe('once')
    expect(proc.readOutput().delta).toBe('')
  })
})
