import { describe, expect, it } from 'vitest'
import { loadWorkspaceConfig } from './config.ts'
import type { MachineVFS } from './vfs/machine/machine.ts'
import { buildVfs } from './vfs/registry.ts'
import { Workspace } from './workspace/workspace/workspace.ts'

describe('workspace max_body_bytes', () => {
  it.each([
    [1024, 1024],
    ['1MB', 1048576],
    [null, 67108864],
  ] as const)('passes %s through the config and constructor', async (value, expected) => {
    const config = loadWorkspaceConfig({ mounts: {}, max_body_bytes: value })
    const ws = new Workspace({}, { maxBodyBytes: config.maxBodyBytes ?? null })
    try {
      expect(ws.registry.bodyLimit).toBe(expected)
    } finally {
      await ws.close()
    }
  })
  it.each([-1, 'lots', '-1MB'])('rejects invalid size %s', (value) => {
    expect(() => loadWorkspaceConfig({ mounts: {}, max_body_bytes: value })).toThrow(
      /max_body_bytes/,
    )
  })
  it('still rejects unknown sibling keys', () => {
    expect(() =>
      loadWorkspaceConfig({ mounts: {}, max_body_bytes: 10, max_body_byte: 10 }),
    ).toThrow(/max_body_byte/)
  })
})

describe('@local', () => {
  it('is the machine VFS at its own path', async () => {
    const config = loadWorkspaceConfig({
      mounts: { '/testbed/': '@local', '/data': { vfs: 'ram' } },
    })
    const block = config.mounts['/testbed/']
    expect([block?.vfs, block?.config]).toEqual(['machine', { root: '/testbed' }])
    const vfs = await buildVfs(block?.vfs ?? '', block?.config ?? {})
    expect([vfs.name, (vfs as MachineVFS).config.root]).toEqual(['machine', '/testbed'])
  })
})
