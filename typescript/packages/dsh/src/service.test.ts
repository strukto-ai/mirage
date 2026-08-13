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
import { Workspace } from '@struktoai/mirage-node'
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
