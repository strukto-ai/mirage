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

import type { Workspace } from '@struktoai/mirage-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FuseManager } from './fuse.ts'

const mocks = vi.hoisted(() => ({
  forceUnmount: vi.fn(),
  mount: vi.fn(),
  rmSync: vi.fn(),
  rmdirSync: vi.fn(),
}))

vi.mock('../fuse/mount.ts', () => ({
  forceUnmount: mocks.forceUnmount,
  mount: mocks.mount,
}))

vi.mock('node:fs', () => ({
  rmSync: mocks.rmSync,
  rmdirSync: mocks.rmdirSync,
}))

// FuseManager is a passive primitive: it only forwards ws to the (mocked)
// mount() and tears the handle down. It never touches the workspace registry,
// so a trivial stub suffices.
function workspaceStub(): Workspace {
  return {} as unknown as Workspace
}

describe('FuseManager (without a real mount)', () => {
  beforeEach(() => {
    mocks.mount.mockReset()
    mocks.rmSync.mockReset()
    mocks.rmdirSync.mockReset()
  })

  it('starts with mountpoint=null', () => {
    const fm = new FuseManager()
    expect(fm.mountpoint).toBeNull()
  })

  it('close() is a no-op when no mountpoint is set', async () => {
    const fm = new FuseManager()
    await fm.close()
    expect(fm.mountpoint).toBeNull()
  })

  it('keeps caller-owned mountpoints after close', async () => {
    // Regression: explicit mountpoints are deployment/caller-owned paths. The
    // manager must unmount FUSE without deleting the directory it mounted on.
    const unmount = vi.fn(() => Promise.resolve())
    mocks.mount.mockResolvedValueOnce({
      mountpoint: '/tmp/caller-owned',
      ownsMountpoint: false,
      unmount,
    })
    const ws = workspaceStub()
    const fm = new FuseManager()

    await fm.setup(ws, { mountpoint: '/tmp/caller-owned' })
    await fm.close()

    expect(unmount).toHaveBeenCalledOnce()
    expect(mocks.rmdirSync).not.toHaveBeenCalled()
    expect(mocks.rmSync).not.toHaveBeenCalled()
  })

  it('removes generated mountpoints with an empty-directory rmdir', async () => {
    // Generated temp mountpoints are Mirage-owned, but cleanup is intentionally
    // rmdir-only so a still-mounted FUSE tree is never recursively deleted.
    const unmount = vi.fn(() => Promise.resolve())
    mocks.mount.mockResolvedValueOnce({
      mountpoint: '/tmp/generated',
      ownsMountpoint: true,
      unmount,
    })
    const ws = workspaceStub()
    const fm = new FuseManager()

    await fm.setup(ws)
    await fm.close()

    expect(unmount).toHaveBeenCalledOnce()
    expect(mocks.rmdirSync).toHaveBeenCalledWith('/tmp/generated')
    expect(mocks.rmSync).not.toHaveBeenCalled()
  })
})
