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
import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { LocalRuntime, registerResourceFactory, Workspace } from '@struktoai/mirage-node'
import { MirageService } from './service.ts'

describe('MirageService', () => {
  it('adopts a live workspace without owning its lifecycle', async () => {
    const ws = new Workspace({ '/data': [new RAMResource(), MountMode.WRITE] })
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, { workspace: ws })
    await fiber.await()
    expect(ctx.mirage.workspace).toBe(ws)
    await fiber.dispose()
    await ws.fs.writeFile('/data/still-open.txt', 'yes')
    expect(await ws.fs.exists('/data/still-open.txt')).toBe(true)
    await ws.close()
  })

  it('owns and closes a workspace built from mounts', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/data': [new RAMResource(), MountMode.WRITE] },
    })
    await fiber.await()
    const ws = ctx.mirage.workspace
    await ws.fs.writeFile('/data/a.txt', 'alive')
    await fiber.dispose()
    await expect(ws.resolve('/data/a.txt')).rejects.toThrow('closed')
  })

  it('builds declarative mounts through the resource registry', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: {
        '/scratch': { resource: 'ram', mode: 'write' },
        '/live': [new RAMResource(), MountMode.WRITE],
      },
      runtimes: [{ name: 'monty', captures: ['python', 'python3'] }],
    })
    await fiber.await()
    expect(() => ctx.mirage.workspace).toThrow('not ready')
    const ws = await ctx.mirage.ready
    expect(ctx.mirage.workspace).toBe(ws)
    await ws.fs.writeFile('/scratch/a.txt', 'declared')
    expect(await ws.fs.exists('/scratch/a.txt')).toBe(true)
    await ws.fs.writeFile('/live/b.txt', 'instance')
    expect(await ws.fs.exists('/live/b.txt')).toBe(true)
    await fiber.dispose()
    await expect(ws.resolve('/scratch/a.txt')).rejects.toThrow('closed')
  })

  it('rejects an unknown declarative resource name', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/x': { resource: 'no-such-backend' } },
    })
    await fiber.await()
    await expect(ctx.mirage.ready).rejects.toThrow('unknown resource')
  })

  it('refuses runtimes in both config keys', async () => {
    const ctx = new Context()
    await expect(
      ctx
        .plugin(MirageService, {
          mounts: { '/x': new RAMResource() },
          runtimes: ['monty'],
          workspaceOptions: { runtimes: ['monty'] },
        })
        .await(),
    ).rejects.toThrow('not both')
  })

  it('reads confinement live off an adopted workspace', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    const ctx = new Context()
    await ctx.plugin(MirageService, { workspace: ws }).await()
    expect(ctx.mirage.confined).toBe(true)
    ws.addRuntime(new LocalRuntime({ captures: ['python'] }))
    expect(ctx.mirage.confined).toBe(false)
    await ws.close()
  })

  it('classifies declared runtimes before the mounts resolve', async () => {
    // The executor runs synchronously, so release is assigned by here.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    registerResourceFactory('gated-ram', async () => {
      await gate
      return new RAMResource()
    })
    const ctx = new Context()
    const fiber = ctx.plugin(MirageService, {
      mounts: { '/scratch': { resource: 'gated-ram' } },
      runtimes: ['local'],
    })
    await fiber.await()
    expect(() => ctx.mirage.workspace).toThrow('not ready')
    expect(ctx.mirage.confined).toBe(false)
    release()
    await ctx.mirage.ready
    expect(ctx.mirage.confined).toBe(false)
    await fiber.dispose()
  })

  it('refuses both and neither of workspace/mounts', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    const ctx = new Context()
    await expect(
      ctx.plugin(MirageService, { workspace: ws, mounts: { '/x': new RAMResource() } }).await(),
    ).rejects.toThrow('not both')
    await expect(ctx.plugin(MirageService, {}).await()).rejects.toThrow('required')
    await ws.close()
  })
})
