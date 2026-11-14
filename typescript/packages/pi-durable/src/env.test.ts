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

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
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
