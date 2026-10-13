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

import { describe, expect, it, vi } from 'vitest'
import type * as asyncContextModule from '../utils/async_context.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { Session, Workspace } from '../workspace/workspace/workspace.ts'
import { getTestParser } from '../workspace/fixtures/workspace_fixture.ts'
import type { Policy } from './base.ts'
import { Outcome, type Action, type CommandContext, type Decision } from './types.ts'

// The browser-runtime branch under node's test runner: no task isolation,
// so a method cannot run as a policy deciding.
vi.mock('../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>() {
      return new real.FallbackStorage<T>()
    },
  }
})

describe('a method without task isolation', () => {
  it('reads the session, writes none of it and gets no files', async () => {
    const refused: string[] = []
    let files: unknown = null
    const writer: Policy = {
      async preCommand(ctx: CommandContext): Promise<Action | null> {
        if (ctx.command !== 'echo' || ctx.session === undefined) return null
        files = ctx.vfs
        try {
          await ctx.session.set('TEAM', 'me')
        } catch (err) {
          refused.push((err as { code?: string }).code ?? '')
        }
        return null
      },
    }
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser(), policies: [writer] },
    )
    try {
      await ws.shell('export TEAM=core')
      expect((await ws.shell('echo $TEAM')).stdoutText).toBe('core\n')
      expect(refused).toEqual(['EACCES'])
      expect(files).toBeUndefined()
      expect((await ws.shell('echo $TEAM')).stdoutText).toBe('core\n')
    } finally {
      await ws.close()
    }
  })

  it("spends a write's approval with that write, while another waits", async () => {
    // A's write waits on the host while B's is approved: B's nod is spent
    // with B's write, not left standing on A's call.
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => (entered = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    const askedB: string[] = []
    const asker: Policy = {
      preSession: (ctx) => (ctx.key === 'X' ? { kind: 'ask', reason: 'x' } : null),
    }
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: await getTestParser(),
        policies: [asker],
        onAsk: async (record: Decision) => {
          if (record.sessionId === 'a') {
            entered()
            await held
          } else {
            askedB.push(record.sessionId)
          }
          return { ...record, outcome: Outcome.ALLOW }
        },
      },
    )
    ws.createSession('a')
    ws.createSession('b')
    try {
      const a = ws.shell('export X=1', { sessionId: 'a' })
      await reached
      expect((await ws.shell('export X=2', { sessionId: 'b' })).exitCode).toBe(0)
      expect((await ws.shell('export X=2', { sessionId: 'b' })).exitCode).toBe(0)
      expect(askedB).toEqual(['b', 'b'])
      release()
      expect((await a).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it("keeps one session's file nod off another session's call", async () => {
    // A's read waits on the host while B's is approved: B's nod is spent
    // with B's call, not claimed on A's.
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => (entered = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    const askedB: string[] = []
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: await getTestParser(),
        onAsk: async (record: Decision) => {
          if (record.sessionId === 'a') {
            entered()
            await held
          } else {
            askedB.push(record.sessionId)
          }
          return { ...record, outcome: Outcome.ALLOW }
        },
      },
    )
    const profile = {
      commands: { ask: [{ reason: 'outbox needs a nod', paths: ['/data/out/*'] }] },
    }
    ws.createSession('a', { profile })
    ws.createSession('b', { profile })
    await ws.shell('mkdir -p /data/out && echo x > /data/out/f.txt')
    try {
      const a = new Session(ws, 'a').tools.read('/data/out/f.txt')
      await reached
      const b = new Session(ws, 'b').tools
      expect((await b.read('/data/out/f.txt')).isError).toBeUndefined()
      expect((await b.read('/data/out/f.txt')).isError).toBeUndefined()
      expect(askedB).toEqual(['b', 'b'])
      release()
      expect((await a).isError).toBeUndefined()
    } finally {
      await ws.close()
    }
  })

  it("finds a session's own call under another session's", async () => {
    // B's call stays open on the host while A's write runs: A's ops find
    // A's call, so its read-back rides the nod its write was given.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const askedA: string[] = []
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        shellParser: await getTestParser(),
        onAsk: async (record: Decision) => {
          if (record.sessionId === 'b') await held
          else askedA.push(record.sessionId)
          return { ...record, outcome: Outcome.ALLOW }
        },
      },
    )
    const profile = {
      commands: { ask: [{ reason: 'outbox needs a nod', paths: ['/data/out/*'] }] },
    }
    ws.createSession('a', { profile })
    ws.createSession('b', { profile })
    await ws.shell('mkdir -p /data/out && echo x > /data/out/f.txt')
    try {
      const a = new Session(ws, 'a').tools.write('/data/out/a.txt', 'hi')
      const b = new Session(ws, 'b').tools.read('/data/out/f.txt')
      expect((await a).isError).toBeUndefined()
      expect(askedA).toEqual(['a'])
      release()
      expect((await b).isError).toBeUndefined()
    } finally {
      await ws.close()
    }
  })

  it("covers a file tool's own reads with one nod", async () => {
    // A write tool reads the file back to stamp its version: the nod for
    // the call covers that read too, and is spent with the call.
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    ws.createSession('agent', {
      profile: { commands: { ask: [{ reason: 'outbox needs a nod', paths: ['/data/out/*'] }] } },
    })
    const tools = new Session(ws, 'agent').tools
    try {
      expect((await tools.write('/data/out/a.txt', 'hi')).isError).toBe(true)
      const [record] = ws.decisions.pending('agent')
      await ws.decisions.answer(record?.id ?? '', Outcome.ALLOW)
      expect((await tools.write('/data/out/a.txt', 'hi')).isError).toBeUndefined()
      expect((await tools.write('/data/out/a.txt', 'again')).isError).toBe(true)
    } finally {
      await ws.close()
    }
  })
})
