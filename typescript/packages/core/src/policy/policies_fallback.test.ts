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
import { type JsonValue, MountMode } from '../types.ts'
import { Session, Workspace } from '../workspace/workspace/workspace.ts'
import { ScriptSource } from '../runtime/types.ts'
import type { Policy } from './base.ts'
import { type Action, type CommandContext, type VfsContext } from './types.ts'
import { currentCaller, runWithCaller } from '../context/session_context.ts'
import { scriptContext } from './script.ts'

// The browser-runtime branch under node's test runner: no task isolation,
// so a method's deciding mark rides its own files and program alone.
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
  it('reads the session, its mounts and its files, and writes nothing', async () => {
    const refused: string[] = []
    const read: string[] = []
    let mounts: JsonValue = null
    const writer: Policy = {
      async preCommand(ctx: CommandContext): Promise<Action | null> {
        if (ctx.command !== 'echo' || ctx.session === undefined) return null
        mounts = scriptContext(ctx).mounts ?? null
        read.push(new TextDecoder().decode(await ctx.vfs?.read('/data/team')))
        for (const call of [
          () => ctx.session?.set('TEAM', 'me'),
          () => ctx.vfs?.write('/data/team', 'me'),
        ]) {
          try {
            await call()
          } catch (err) {
            refused.push((err as { code?: string }).code ?? '')
          }
        }
        return null
      },
    }
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, policies: [writer] },
    )
    try {
      await ws.vfs.write('/data/team', 'core')
      await ws.shell('export TEAM=core')
      expect((await ws.shell('echo $TEAM')).stdoutText).toBe('core\n')
      expect(read).toEqual(['core'])
      expect(refused).toEqual(['EACCES', 'EROFS'])
      expect(mounts).toContain('/data')
      expect((await ws.shell('echo $TEAM')).stdoutText).toBe('core\n')
      expect(new TextDecoder().decode(await ws.vfs.read('/data/team'))).toBe('core')
    } finally {
      await ws.close()
    }
  })

  it("explains a line with its policies deciding, a program's write refused", async () => {
    // explain.shell runs no policy for real: a coded method reads and a
    // profile's program reads, and neither one's write lands.
    const source =
      'def pre_command(ctx):\n' +
      "    value = open('/data/rule').read()\n" +
      '    try:\n' +
      "        open('/data/mark', 'w').write('x')\n" +
      '    except OSError:\n' +
      '        pass\n' +
      "    return {'kind': 'deny', 'reason': value}"
    const read: string[] = []
    const refused: string[] = []
    const coded: Policy = {
      async preCommand(ctx: CommandContext): Promise<Action | null> {
        if (ctx.command !== 'cat') return null
        read.push(new TextDecoder().decode(await ctx.vfs?.read('/data/rule')))
        try {
          await ctx.vfs?.write('/data/coded', 'x')
        } catch (err) {
          refused.push((err as { code?: string }).code ?? '')
        }
        return null
      },
    }
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        policies: [coded],
        profiles: {
          checked: {
            policy: {
              preCommand: [{ runtime: 'monty', script: new ScriptSource(source, 'python') }],
            },
          },
        },
      },
    )
    try {
      await ws.vfs.write('/data/rule', 'sealed')
      ws.createSession('s', { profile: 'checked' })
      const said = await new Session(ws, 's').explain.shell('cat /data/rule')
      expect(JSON.stringify(said)).toContain('sealed')
      expect(read).toEqual(['sealed'])
      expect(refused).toEqual(['EROFS'])
      expect(await ws.vfs.exists('/data/mark')).toBe(false)
      expect(await ws.vfs.exists('/data/coded')).toBe(false)
    } finally {
      await ws.close()
    }
  }, 30_000)

  it("asks a file tool's ops of the methods even when a line's caller is in reach", async () => {
    // Without task isolation the newest caller may be another task's line,
    // whose I/O skips the methods: a tool call copying it would write
    // past one.
    const sealed: Policy = {
      preVfs: (ctx: VfsContext) =>
        ctx.call.name === 'write' && ctx.path.virtual.startsWith('/data/sealed')
          ? { kind: 'deny', reason: 'sealed' }
          : null,
    }
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, policies: [sealed] },
    )
    ws.createSession('agent')
    const tools = new Session(ws, 'agent').tools
    try {
      const line = { ...currentCaller(), refusals: (): void => undefined }
      const result = await runWithCaller(line, () => tools.write('/data/sealed/a.txt', 'x'))
      expect(result.isError).toBe(true)
      expect(await ws.vfs.exists('/data/sealed/a.txt')).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it("keeps the default session's hides on its tools while a wider session's call waits", async () => {
    // The default session's tools bind it by id: the unnamed facade keeps
    // whichever live session is in reach, here the wider one's.
    let holding = false
    let entered!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => (entered = resolve))
    const held = new Promise<void>((resolve) => (release = resolve))
    const holds: Policy = {
      preVfs: async (ctx: VfsContext) => {
        if (holding && ctx.sessionId === 'admin' && ctx.path.virtual === '/data/hold.txt') {
          entered()
          await held
        }
        return null
      },
    }
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        profiles: { narrow: { paths: { hide: ['/data/secret'] } } },
        profile: 'narrow',
        policies: [holds],
      },
    )
    ws.createSession('admin', { profile: {} })
    await ws.shell(
      'mkdir -p /data/secret && echo s > /data/secret/x.txt && echo h > /data/hold.txt',
      {
        sessionId: 'admin',
      },
    )
    holding = true
    try {
      const wide = new Session(ws, 'admin').tools.read('/data/hold.txt')
      await reached
      expect((await ws.tools.read('/data/secret/x.txt')).isError).toBe(true)
      release()
      expect((await wide).isError).toBeUndefined()
    } finally {
      await ws.close()
    }
  })
})

it('carries the script issuer through postVfs without task isolation', async () => {
  const source =
    "def post_vfs(ctx):\n    value = open('/data/rule').read()\n    return {'kind': 'deny', 'reason': value}"
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      profiles: {
        checked: {
          policy: {
            postVfs: [
              {
                runtime: 'monty',
                script: new ScriptSource(source, 'python'),
              },
            ],
          },
        },
      },
    },
  )
  try {
    await ws.vfs.write('/data/rule', 'checked once')
    await ws.vfs.write('/data/value', 'payload')
    ws.createSession('s', { profile: 'checked' })
    const result = await new Session(ws, 's').tools.read('/data/value')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('checked once')
  } finally {
    await ws.close()
  }
}, 30_000)
