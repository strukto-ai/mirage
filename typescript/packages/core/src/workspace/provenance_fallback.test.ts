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
import { MountMode } from '../types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Workspace } from './workspace/workspace.ts'

// The browser-runtime branch under node's test runner: no task
// isolation, so Files builds the row itself from the op's report.
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

describe('namespace answers without task isolation', () => {
  it('records a getxattr as served by the namespace', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.vfs.write('/data/f.txt', 'hello')
      await ws.vfs.setxattr('/data/f.txt', 'user.k', new TextEncoder().encode('v'))
      ws.records.length = 0
      await ws.vfs.getxattr('/data/f.txt', 'user.k')
      expect(ws.records.map((r) => [r.op, r.source, r.served, r.bytes])).toEqual([
        ['getxattr', 'ram', 'namespace', 1],
      ])
    } finally {
      await ws.close()
    }
  })

  it('records an overlay-only setattr as served by the namespace', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.vfs.write('/data/f.txt', 'hello')
      await ws.vfs.symlink('/data/link', 'f.txt')
      ws.records.length = 0
      await ws.vfs.setattr('/data/link', { mode: 0o640, nofollow: true })
      expect(ws.records.map((r) => [r.op, r.source, r.served])).toEqual([
        ['setattr', 'ram', 'namespace'],
      ])
    } finally {
      await ws.close()
    }
  })
})
