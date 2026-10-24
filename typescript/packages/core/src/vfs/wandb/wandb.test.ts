import { expect, it, vi } from 'vitest'
import { WandbVFS } from './wandb.ts'
import { normalizeWandbConfig } from '../../core/wandb/config.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { MountMode } from '../../types.ts'

it('isolates mount scopes and directory indexes', async () => {
  const mounts = [
    new WandbVFS(normalizeWandbConfig({ entities: ['lab', 'lab'] })),
    new WandbVFS(normalizeWandbConfig({ entities: ['other'] })),
  ]
  const requests = mounts.map((vfs) => vi.spyOn(vfs.accessor.client, 'request'))
  const shellParser = await getTestParser()
  const workspaces = mounts.map((vfs) => new Workspace({ '/wandb': vfs }, { shellParser }))
  try {
    for (const [i, ws] of workspaces.entries()) {
      const result = await ws.shell('ls /wandb')
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout).trim()).toBe(i === 0 ? 'lab' : 'other')
      expect((await ws.shell(`ls /wandb/${i === 0 ? 'other' : 'lab'}`)).exitCode).not.toBe(0)
    }
    for (const request of requests) expect(request).not.toHaveBeenCalled()
  } finally {
    for (const ws of workspaces) await ws.close()
  }
})

it('refuses W&B mutations and CLI dispatch even in a write workspace', async () => {
  const vfs = new WandbVFS(normalizeWandbConfig({ entities: ['lab'] }))
  const request = vi.spyOn(vfs.accessor.client, 'request')
  const ws = new Workspace(
    { '/wandb': vfs },
    {
      mode: MountMode.WRITE,
      shellParser: await getTestParser(),
    },
  )
  try {
    for (const command of [
      'echo bad > /wandb/lab/project/run/summary.json',
      'mkdir /wandb/lab/new-project',
      'type -t wandb',
    ])
      expect((await ws.shell(command)).exitCode).not.toBe(0)
    expect(request).not.toHaveBeenCalled()
  } finally {
    await ws.close()
  }
})

// Twin of test_find_pages_projects_no_further_than_its_walk_limit.
it('lets find page projects no further than its walk limit', async () => {
  const vfs = new WandbVFS(normalizeWandbConfig({ entities: ['lab'], page_size: 1, walk_limit: 2 }))
  const request = vi
    .spyOn(vfs.accessor.client, 'request')
    .mockImplementation((_query, variables) => {
      const n = Number(variables.cursor ?? 0)
      return Promise.resolve({
        models: {
          edges: [{ node: { name: `p${String(n)}` } }],
          pageInfo: { endCursor: String(n + 1), hasNextPage: true },
        },
      } as never)
    })
  const ws = new Workspace({ '/wandb': vfs }, { shellParser: await getTestParser() })
  try {
    await ws.shell('find /wandb/lab -maxdepth 1')
    expect(request).toHaveBeenCalledTimes(3)
  } finally {
    await ws.close()
  }
})
