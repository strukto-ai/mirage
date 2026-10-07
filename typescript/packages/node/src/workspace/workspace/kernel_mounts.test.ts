import { MountBackend } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { describe, expect, it, vi } from 'vitest'
import { KernelMounts } from './kernel_mounts.ts'

vi.mock('../fuse.ts', () => ({
  FuseManager: class {
    setup(_ws: unknown, opts: { rootPrefix: string; mountpoint?: string }): Promise<string> {
      if (opts.mountpoint === '/mnt/fail') return Promise.reject(new Error('no fuse'))
      if (opts.mountpoint === '/mnt/slow') {
        return new Promise((resolve) =>
          setTimeout(() => {
            resolve('/mnt/slow')
          }, 20),
        )
      }
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

  it('holds an exposure while its setup is pending, and drops a failed one', async () => {
    // A conditional mount added while setup is in flight must already see
    // the exposure, or it slips under the kernel mount.
    const ws = { getSession: (id: string) => id } as unknown as Workspace
    const mounts = new KernelMounts(ws)
    const pending = mounts.add('/s3', '/mnt/slow')
    expect(mounts.exposed()).toEqual([['/s3', MountBackend.FUSE]])
    await pending
    await expect(mounts.add('/x', '/mnt/fail')).rejects.toThrow('no fuse')
    expect(mounts.exposed()).toEqual([['/s3', MountBackend.FUSE]])
    // A failed second expose of a live prefix keeps the live one's record.
    await expect(mounts.add('/s3', '/mnt/fail')).rejects.toThrow('no fuse')
    expect(mounts.exposed()).toEqual([['/s3', MountBackend.FUSE]])
    expect(mounts.mountpoints).toEqual({ '/s3': '/mnt/slow' })
  })
})
