import { MountBackend } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { describe, expect, it, vi } from 'vitest'
import { KernelMounts } from './kernel_mounts.ts'

vi.mock('../fuse.ts', () => ({
  FuseManager: class {
    setup(_ws: unknown, opts: { rootPrefix: string; mountpoint?: string }): Promise<string> {
      return Promise.resolve(opts.mountpoint ?? `/mnt${opts.rootPrefix}`)
    }
    unmount(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

describe('KernelMounts.exposed', () => {
  it('follows add, remove and close', async () => {
    const ws = { getSession: (id: string) => id } as unknown as Workspace
    const mounts = new KernelMounts(ws)
    await mounts.add('/s3', '/mnt/one', undefined, MountBackend.FSKIT)
    await mounts.add('/s3', '/mnt/two', 'agent')
    await mounts.add('/a@b', '/mnt/three')
    expect(mounts.exposed().sort()).toEqual([
      ['/a@b', MountBackend.FUSE],
      ['/s3', MountBackend.FSKIT],
      ['/s3', MountBackend.FUSE],
    ])
    await mounts.remove('/s3', 'agent')
    expect(mounts.exposed().sort()).toEqual([
      ['/a@b', MountBackend.FUSE],
      ['/s3', MountBackend.FSKIT],
    ])
    await mounts.close()
    expect(mounts.exposed()).toEqual([])
  })
})
