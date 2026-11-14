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

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { getOrThrow } from '@earendil-works/pi-durable/env'
import { registerEnvConformance } from '@earendil-works/pi-durable/testing'
import type { Action, CommandContext, Policy } from '@struktoai/mirage-core/policy/index'
import { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { MirageExecutionEnv } from './env.ts'

const context = BACKGROUND_CONTEXT

function mkWs(policies: Policy[] = []): Workspace {
  return new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE, policies })
}

let cases = 0

registerEnvConformance({ describe, expect, it }, 'MirageExecutionEnv', async (use) => {
  const ws = mkWs()
  cases += 1
  const cwd = `/case-${String(cases)}`
  await ws.vfs.mkdir(cwd)
  const env = new MirageExecutionEnv(ws, { cwd, watch: { pollIntervalMs: 50 } })
  try {
    await use(env)
  } finally {
    await env.cleanup(context)
  }
})

describe('MirageExecutionEnv over mounts', () => {
  it('reads and writes the mounted backend through the dispatcher', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    const env = new MirageExecutionEnv(ws, { cwd: '/data' })
    getOrThrow(await env.writeFile('notes/a.txt', 'hello', context))
    expect(new TextDecoder().decode(await ws.vfs.read('/data/notes/a.txt'))).toBe('hello')
    const out: string[] = []
    const result = await env.exec(
      'cat notes/a.txt | wc -c',
      {
        onOutput: (text) => out.push(text),
      },
      context,
    )
    expect(getOrThrow(result).exitCode).toBe(0)
    expect(out.join('').trim()).toBe('5')
  })

  it('shares one id across environments over one workspace', () => {
    const ws = mkWs()
    expect(new MirageExecutionEnv(ws).id).toBe(new MirageExecutionEnv(ws, { cwd: '/x' }).id)
    expect(new MirageExecutionEnv(ws).id).not.toBe(new MirageExecutionEnv(mkWs()).id)
    expect(new MirageExecutionEnv(ws, { id: 'mine' }).id).toBe('mine')
  })

  it('spills output past its bounds to a file the environment can read', async () => {
    const env = new MirageExecutionEnv(mkWs())
    const result = getOrThrow(
      await env.exec('seq 1 50', { spill: { afterBytes: 1_000_000, afterLines: 10 } }, context),
    )
    expect(result.spillPath).toMatch(/^\/tmp\/.*\/pi-output-.*\.log$/)
    const spilled = getOrThrow(await env.readTextFile(result.spillPath ?? '', context))
    expect(spilled.split('\n')).toHaveLength(51)
  })

  it('spills output that passes the flush size in full', async () => {
    const env = new MirageExecutionEnv(mkWs())
    const result = getOrThrow(
      await env.exec('seq 1 200000', { spill: { afterBytes: 1_000_000, afterLines: 10 } }, context),
    )
    const spilled = getOrThrow(await env.readTextFile(result.spillPath ?? '', context))
    expect(spilled.split('\n')).toHaveLength(200001)
    expect(spilled.endsWith('199999\n200000\n')).toBe(true)
  })

  it('keeps draining a spilling command while a snapshot waits for it', async () => {
    const ws = mkWs()
    const env = new MirageExecutionEnv(ws)
    let snapshot: Promise<Uint8Array> | undefined
    const result = getOrThrow(
      await env.exec(
        'echo start; sleep 0.3; seq 1 300000',
        {
          spill: { afterBytes: 1_000_000, afterLines: 10 },
          onOutput: (text) => {
            if (snapshot === undefined && text.startsWith('start')) snapshot = ws.snapshot()
          },
        },
        context,
      ),
    )
    expect(result.exitCode).toBe(0)
    expect((await snapshot)?.byteLength).toBeGreaterThan(0)
    const spilled = getOrThrow(await env.readTextFile(result.spillPath ?? '', context))
    expect(spilled.split('\n')).toHaveLength(300002)
  }, 20_000)

  it('keeps the spill of a command aborted after its output passed the bounds', async () => {
    const env = new MirageExecutionEnv(mkWs())
    const controller = new AbortController()
    const result = await env.exec(
      'seq 1 50; sleep 5',
      {
        spill: { afterBytes: 1_000_000, afterLines: 10 },
        onOutput: (text) => {
          if (text.includes('50\n')) controller.abort()
        },
      },
      withAbortSignal(controller.signal, context),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('aborted')
    const spilled = getOrThrow(await env.readTextFile(result.error.spillPath ?? '', context))
    expect(spilled.split('\n')).toHaveLength(51)
  })

  it('refuses to remove or rename a mount root, leaving its files', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    await ws.vfs.write('/data/a.txt', 'kept')
    const env = new MirageExecutionEnv(ws)
    for (const result of [
      await env.remove('/data', { recursive: true }, context),
      await env.remove('/', { recursive: true, force: true }, context),
      await env.renameFile('/data', '/moved', context),
    ]) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain('Device or resource busy')
    }
    expect(new TextDecoder().decode(await ws.vfs.read('/data/a.txt'))).toBe('kept')
  })

  it('walks no dot or trailing slash past a file', async () => {
    const env = new MirageExecutionEnv(mkWs())
    getOrThrow(await env.writeFile('/file', 'x', context))
    for (const path of ['/file/..', '/file/.', '/file/', '/file/../file']) {
      const result = await env.canonicalPath(path, context)
      expect(result.ok ? result.value : result.error.code).toBe('not_directory')
    }
    expect(getOrThrow(await env.canonicalPath('/./file', context))).toBe('/file')
  })

  it('names a policy refusal after the shell output', async () => {
    class NoDeletes implements Policy {
      preCommand(ctx: CommandContext): Action | null {
        if (ctx.command === 'rm') return { kind: 'deny', reason: 'no deletes' }
        return null
      }
    }
    const ws = mkWs([new NoDeletes()])
    await ws.vfs.write('/x', 'hush')
    const env = new MirageExecutionEnv(ws)
    const output = { stdout: '', stderr: '' }
    const result = getOrThrow(
      await env.exec(
        'rm /x',
        { onOutput: (text, _context, info) => (output[info.stream] += text) },
        context,
      ),
    )
    expect(result.exitCode).toBe(126)
    expect(output.stderr).toBe('rm: Permission denied\npolicy denied: no deletes\n')
  })

  it('acts as the session, under its profile', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS(), '/vault': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        profiles: { guarded: SessionProfile({ paths: { hide: ['/vault'] } }) },
      },
    )
    await ws.shell('echo key > /vault/key.txt')
    ws.createSession('agent', { profile: 'guarded' })
    const agent = new MirageExecutionEnv(ws, { sessionId: 'agent' })
    expect(getOrThrow(await agent.exists('/vault/key.txt', context))).toBe(false)
    expect(getOrThrow(await new MirageExecutionEnv(ws).exists('/vault/key.txt', context))).toBe(
      true,
    )
  })
})
