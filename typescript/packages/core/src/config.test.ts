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

describe('@<machine>', () => {
  it('names a machine the document defines, wherever it sits', () => {
    const machines = { gpu: { provider: 'docker', container: 'c' } }
    const config = loadWorkspaceConfig({ mounts: { '/tmp': '@gpu' }, machines })
    expect(config.mounts['/tmp']?.config).toEqual({ root: '/tmp', machines: ['gpu'] })
    expect(() => loadWorkspaceConfig({ mounts: { '/tmp': '@cpu' }, machines })).toThrow(
      "no machine 'cpu' (machines: 'gpu')",
    )
    expect(() =>
      loadWorkspaceConfig({
        mounts: { '/tmp': { vfs: 'machine', config: { root: '/tmp', default_machine: 'cpu' } } },
        machines,
      }),
    ).toThrow("no machine 'cpu'")
  })

  it("is that machine's files at its own path", async () => {
    const config = loadWorkspaceConfig({
      mounts: { '/tmp/': '@gpu', '/data': { vfs: 'ram' } },
    })
    const block = config.mounts['/tmp/']
    expect([block?.vfs, block?.config]).toEqual(['machine', { root: '/tmp', machines: ['gpu'] }])
    const vfs = (await buildVfs(block?.vfs ?? '', block?.config ?? {})) as MachineVFS
    expect([vfs.name, vfs.config.root, vfs.config.machines]).toEqual(['machine', '/tmp', ['gpu']])
  })
})
