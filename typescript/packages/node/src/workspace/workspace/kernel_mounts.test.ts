import { MountBackend, WritePolicy } from '@struktoai/mirage-core/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { describe, expect, it, vi } from 'vitest'
import { KernelMounts } from './kernel_mounts.ts'

vi.mock('../fuse.ts', () => ({
  FuseManager: class {
    setup(_ws: unknown, opts: { rootPrefix: string; mountpoint?: string }): Promise<string> {
      if (opts.mountpoint === '/mnt/fail') return Promise.reject(new Error('no fuse'))
      if (opts.mountpoint === '/mnt/slowfail' || opts.mountpoint === '/mnt/slowerfail') {
        return new Promise((_resolve, reject) =>
          setTimeout(
            () => {
              reject(new Error('no fuse'))
            },
            opts.mountpoint === '/mnt/slowfail' ? 20 : 40,
          ),
        )
      }
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
    const ws = { getSession: (id: string) => id, mounts: () => [] } as unknown as Workspace
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
    const ws = { getSession: (id: string) => id, mounts: () => [] } as unknown as Workspace
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

  it('keeps a later expose of the key when an earlier one fails', async () => {
    // Two exposes of one prefix overlap; the first failing after the second
    // came up must not roll back the second's live records.
    const ws = { getSession: (id: string) => id, mounts: () => [] } as unknown as Workspace
    const mounts = new KernelMounts(ws)
    const first = mounts.add('/s3', '/mnt/slowfail')
    await mounts.add('/s3', '/mnt/two')
    await expect(first).rejects.toThrow('no fuse')
    expect(mounts.exposed()).toEqual([['/s3', MountBackend.FUSE]])
    expect(mounts.mountpoints).toEqual({ '/s3': '/mnt/two' })
  })

  it('lists no mount when two overlapping exposes of the key both fail', async () => {
    // The later failure must not put back the earlier, dead one.
    const ws = { getSession: (id: string) => id, mounts: () => [] } as unknown as Workspace
    const mounts = new KernelMounts(ws)
    const first = mounts.add('/s3', '/mnt/slowfail')
    const second = mounts.add('/s3', '/mnt/slowerfail')
    await expect(first).rejects.toThrow('no fuse')
    await expect(second).rejects.toThrow('no fuse')
    expect(mounts.exposed()).toEqual([])
    expect(mounts.mountpoints).toEqual({})
  })

  it.each(['close', 'remove'] as const)(
    'tears down a setup still queued at %s',
    async (teardown) => {
      // A setup waiting behind another of its key must not come up after
      // the workspace closed or the prefix was removed.
      const ws = { getSession: (id: string) => id, mounts: () => [] } as unknown as Workspace
      const mounts = new KernelMounts(ws)
      const first = mounts.add('/s3', '/mnt/slow')
      const second = mounts.add('/s3', '/mnt/two')
      if (teardown === 'close') await mounts.close()
      else await mounts.remove('/s3')
      await Promise.all([first, second])
      expect(mounts.exposed()).toEqual([])
      expect(mounts.mountpoints).toEqual({})
    },
  )

  it('refuses a queued setup when a conditional mount arrived while it waited', async () => {
    // The refusal is judged when a setup starts, not when it was queued.
    const table: { prefix: string; write: WritePolicy }[] = []
    const ws = { getSession: (id: string) => id, mounts: () => table } as unknown as Workspace
    const mounts = new KernelMounts(ws)
    const first = mounts.add('/s3', '/mnt/slowfail')
    const arrived = first.catch(() => {
      table.push({ prefix: '/s3/', write: WritePolicy.CONDITIONAL })
    })
    const second = mounts.add('/s3', '/mnt/two')
    await arrived
    await expect(second).rejects.toThrow('write: conditional cannot be exposed')
    expect(mounts.exposed()).toEqual([])
    expect(mounts.mountpoints).toEqual({})
  })
})
