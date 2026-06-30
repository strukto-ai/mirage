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
import { IOResult } from '../../io/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { Workspace } from '../workspace.ts'

describe('Namespace facade', () => {
  it('resolve delegates to the workspace resolver', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    const viaNs = await ws.namespace.resolve('/data/a.txt')
    const viaWs = await ws.resolve('/data/a.txt')
    expect(viaNs).toEqual(viaWs)
    await ws.close()
  })

  it('follow is a no-op without a symlink table', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    const withFollow = await ws.namespace.resolve('/data/a.txt', true)
    const noFollow = await ws.namespace.resolve('/data/a.txt', false)
    expect(withFollow).toEqual(noFollow)
    await ws.close()
  })

  it('exposes dispatch and applyIo through the facade', async () => {
    const ws = new Workspace({ '/data': new RAMResource() })
    expect(typeof ws.namespace.dispatch).toBe('function')
    await ws.namespace.applyIo(new IOResult())
    await ws.close()
  })
})
