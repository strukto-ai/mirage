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
import { Context } from '@deepseek-ai/cordis'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { LocalRuntime, Workspace, registerVfsFactory } from '@struktoai/mirage-node'
import { MirageService } from './service.ts'

describe('MirageService', () => {
  it('adopts a live workspace without owning its lifecycle', async () => {
    const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] })
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, { workspace: ws })
    await fiber.await()
    expect(ctx.mirage.workspace).toBe(ws)
    await fiber.dispose()
    await ws.vfs.writeFile('/data/still-open.txt', 'yes')
    expect(await ws.vfs.exists('/data/still-open.txt')).toBe(true)
    await ws.close()
  })

  it('owns and closes a workspace built from mounts', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/data': [new RAMVFS(), MountMode.WRITE] },
    })
    await fiber.await()
    const ws = ctx.mirage.workspace
    await ws.vfs.writeFile('/data/a.txt', 'alive')
    await fiber.dispose()
    await expect(ws.resolve('/data/a.txt')).rejects.toThrow('closed')
  })

  it('builds declarative mounts through the VFS registry', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: {
        '/scratch': { vfs: 'ram', mode: 'write' },
        '/live': [new RAMVFS(), MountMode.WRITE],
      },
      runtimes: [{ name: 'monty', captures: ['python', 'python3'] }],
    })
    await fiber.await()
    expect(() => ctx.mirage.workspace).toThrow('not ready')
    const ws = await ctx.mirage.ready
    expect(ctx.mirage.workspace).toBe(ws)
    await ws.vfs.writeFile('/scratch/a.txt', 'declared')
    expect(await ws.vfs.exists('/scratch/a.txt')).toBe(true)
    await ws.vfs.writeFile('/live/b.txt', 'instance')
    expect(await ws.vfs.exists('/live/b.txt')).toBe(true)
    await fiber.dispose()
    await expect(ws.resolve('/scratch/a.txt')).rejects.toThrow('closed')
  })

  it('rejects an unknown declarative VFS name', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/x': { vfs: 'no-such-backend' } },
    })
    await fiber.await()
    await expect(ctx.mirage.ready).rejects.toThrow('unknown VFS')
  })

  it('refuses runtimes in both config keys', async () => {
    const ctx = new Context()
    await expect(
      ctx
        .plugin(MirageService, {
          mounts: { '/x': new RAMVFS() },
          runtimes: ['monty'],
          workspaceOptions: { runtimes: ['monty'] },
        })
        .await(),
    ).rejects.toThrow('not both')
  })

  it('reads confinement live off an adopted workspace', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    const ctx = new Context()
    await ctx.plugin(MirageService, { workspace: ws }).await()
    expect(ctx.mirage.vfsOnly).toBe(true)
    ws.addRuntime(new LocalRuntime({ captures: ['python'] }))
    expect(ctx.mirage.vfsOnly).toBe(false)
    await ws.close()
  })

  it('classifies declared runtimes before the mounts resolve', async () => {
    // The executor runs synchronously, so release is assigned by here.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    registerVfsFactory('gated-ram', async () => {
      await gate
      return new RAMVFS()
    })
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/scratch': { vfs: 'gated-ram' } },
      runtimes: ['local'],
    })
    await fiber.await()
    expect(() => ctx.mirage.workspace).toThrow('not ready')
    expect(ctx.mirage.vfsOnly).toBe(false)
    release()
    await ctx.mirage.ready
    expect(ctx.mirage.vfsOnly).toBe(false)
    await fiber.dispose()
  })

  it('refuses both and neither of workspace/mounts', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    const ctx = new Context()
    await expect(
      ctx.plugin(MirageService, { workspace: ws, mounts: { '/x': new RAMVFS() } }).await(),
    ).rejects.toThrow('not both')
    await expect(ctx.plugin(MirageService, {}).await()).rejects.toThrow('required')
    await ws.close()
  })
  it('does not emit an unhandled rejection when a mount fails to build', async () => {
    const seen: unknown[] = []
    const onUnhandled = (err: unknown): void => {
      seen.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/x': { vfs: 'no-such-VFS-xyz' } },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    process.off('unhandledRejection', onUnhandled)
    expect(seen).toEqual([])
    await expect(ctx.mirage.ready).rejects.toThrow(/unknown VFS/)
    await fiber.dispose()
  })

  it('still rejects `ready` for a caller that awaits it', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/x': { vfs: 'no-such-VFS-xyz' } },
    })
    await fiber.await()
    await expect(ctx.mirage.ready).rejects.toThrow(/unknown VFS/)
    await fiber.dispose()
  })

  it('refuses runtimes or workspace options beside an adopted workspace', async () => {
    const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] })
    const ctx = new Context()
    await expect(
      ctx.plugin(MirageService, { workspace: ws, runtimes: ['monty'] }).await(),
    ).rejects.toThrow(/adopted workspace/)
    await expect(
      ctx.plugin(MirageService, { workspace: ws, workspaceOptions: {} }).await(),
    ).rejects.toThrow(/adopted workspace/)
    await ws.close()
  })

  it('accepts a permission document as written, YAML-friendly', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/data': [new RAMVFS(), MountMode.WRITE] },
      profiles: {
        agent: {
          commands: {
            allow: ['cat', 'echo', 'rm'],
            deny: [{ reason: 'no removes', commands: ['rm'] }],
          },
        },
      },
      profile: 'agent',
    })
    await fiber.await()
    const ws = await ctx.mirage.ready
    // The role reached the workspace and governs its default session: a
    // patch file's plain YAML became a live permission document.
    const denied = await ws.shell('rm /data/x.txt')
    expect(denied.exitCode).toBe(126)
    expect(denied.stderrText).toBe('rm: Permission denied\n')
    expect(denied.refusal?.reason).toBe('no removes')
    await fiber.dispose()
  })

  it('rejects a misspelled field in a role at load, not at first use', async () => {
    const ctx = new Context()
    await expect(
      ctx
        .plugin(MirageService, {
          mounts: { '/data': new RAMVFS() },
          profiles: { agent: { commnads: { deny: [] } } },
        })
        .await(),
    ).rejects.toThrow(/profile `agent`/)
  })

  it('refuses a profile name no role defines', async () => {
    const ctx = new Context()
    await expect(
      ctx
        .plugin(MirageService, {
          mounts: { '/data': new RAMVFS() },
          profiles: { agent: {} },
          profile: 'nobody',
        })
        .await(),
    ).rejects.toThrow()
  })

  it('refuses profiles in both config keys', async () => {
    const ctx = new Context()
    await expect(
      ctx
        .plugin(MirageService, {
          mounts: { '/x': new RAMVFS() },
          profiles: { agent: {} },
          workspaceOptions: { profiles: {} },
        })
        .await(),
    ).rejects.toThrow('not both')
  })

  it('refuses profiles beside an adopted workspace', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() })
    const ctx = new Context()
    await expect(
      ctx.plugin(MirageService, { workspace: ws, profiles: { agent: {} } }).await(),
    ).rejects.toThrow(/adopted workspace/)
    await expect(
      ctx.plugin(MirageService, { workspace: ws, profile: 'agent' }).await(),
    ).rejects.toThrow(/adopted workspace/)
    await ws.close()
  })

  it('explains a line without running it or raising a question', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/data': [new RAMVFS(), MountMode.WRITE] },
      profiles: {
        agent: {
          commands: {
            allow: ['cat', 'rm'],
            ask: [{ reason: 'deletes are reviewed', commands: ['rm'] }],
          },
        },
      },
      profile: 'agent',
    })
    await fiber.await()
    const ws = await ctx.mirage.ready
    await ws.vfs.writeFile('/data/notes.txt', 'private')
    const [asked] = await ctx.mirage.explain('rm /data/notes.txt')
    expect(asked?.outcome).toBe('ask')
    expect(asked?.reason).toBe('deletes are reviewed')
    expect(asked?.exitCode).not.toBe(0)
    // A dry run puts no question to anybody and spends nothing.
    expect(ctx.mirage.decisions.pending()).toHaveLength(0)
    expect(await ws.vfs.exists('/data/notes.txt')).toBe(true)
    const [allowed] = await ctx.mirage.explain('cat /data/notes.txt')
    expect(allowed?.outcome).toBe('allow')
    expect(allowed?.exitCode).toBe(0)
    await fiber.dispose()
  })
})
