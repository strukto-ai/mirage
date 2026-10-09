import { IndexEntry } from '../../cache/index/config.ts'
import { expect, it } from 'vitest'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

const routes = [
  [stat, ''],
  [stat, '/page.json'],
  [readdir, ''],
  [read, '/page.json'],
  [stat, '/Child__child'],
  [read, '/Child__child/page.json'],
  [readdir, '/Child__child'],
] as const

it.each(['title', 'parent', 'trash', 'archived'])(
  'validates a row at every entry point: %s',
  async (change) => {
    for (const [operation, suffix] of routes) {
      const calls: string[] = []
      const accessor = {
        transport: {
          callTool: (name: string, args: Record<string, unknown>) => {
            calls.push(name)
            expect(args.page_id).toBe('row')
            return Promise.resolve({
              id: 'row',
              properties: { Name: { type: 'title', title: [{ plain_text: 'Row' }] } },
              parent: { data_source_id: change === 'parent' ? 'other' : 'ds' },
              in_trash: change === 'trash',
              archived: change === 'archived',
            })
          },
        },
      }
      const label = change === 'title' ? 'Wrong' : 'Row'
      const virtual = `/databases/DB__db/DS__ds/${label}__row${suffix}`
      const path = new PathSpec({ virtual, directory: virtual, vfsPath: virtual })
      const index = new RAMIndexCacheStore()
      await index.setPartialDir('/databases/DB__db', [
        [
          'DS__ds',
          new IndexEntry({
            id: 'ds',
            name: 'DS__ds',
            vfsName: 'DS__ds',
            resourceType: 'notion/data_source',
          }),
        ],
      ])
      await index.setDir(virtual, [])
      await expect(operation(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(calls).toEqual(['API-retrieve-a-page'])
    }
  },
)

it('keeps the containing row identity when reading a child', async () => {
  const pages: unknown[] = []
  const accessor = {
    transport: {
      callTool: (name: string, args: Record<string, unknown>) => {
        if (name === 'API-retrieve-block-children')
          return Promise.resolve({ results: [], has_more: false, next_cursor: null })
        pages.push(args.page_id)
        return Promise.resolve(
          args.page_id === 'row'
            ? {
                id: 'row',
                parent: { data_source_id: 'ds' },
                properties: { Name: { type: 'title', title: [{ plain_text: 'Row' }] } },
              }
            : { id: 'child' },
        )
      },
    },
  }
  const path = PathSpec.fromStrPath('/databases/DB__db/DS__ds/Row__row/Child__child/page.json')
  const index = new RAMIndexCacheStore()
  await index.setPartialDir('/databases/DB__db', [
    [
      'DS__ds',
      new IndexEntry({
        id: 'ds',
        name: 'DS__ds',
        vfsName: 'DS__ds',
        resourceType: 'notion/data_source',
      }),
    ],
  ])
  await index.setPartialDir('/databases/DB__db/DS__ds/Row__row', [
    [
      'Child__child',
      new IndexEntry({
        id: 'child',
        name: 'Child__child',
        vfsName: 'Child__child',
        resourceType: 'notion/page',
      }),
    ],
  ])
  await read(accessor, path, index)
  expect(pages).toContain('row')
  expect(pages.at(-1)).toBe('child')
})

it('rejects a missing child beneath a valid row', async () => {
  const listed: unknown[] = []
  const accessor = {
    transport: {
      callTool: (name: string, args: Record<string, unknown>) => {
        if (name === 'API-retrieve-block-children') {
          listed.push(args.block_id)
          return Promise.resolve({ results: [], has_more: false, next_cursor: null })
        }
        return Promise.resolve({
          id: 'row',
          parent: { data_source_id: 'ds' },
          properties: { Name: { type: 'title', title: [{ plain_text: 'Row' }] } },
        })
      },
    },
  }
  const path = PathSpec.fromStrPath('/databases/DB__db/DS__ds/Row__row/Fabricated__missing')
  const index = new RAMIndexCacheStore()
  await index.setPartialDir('/databases/DB__db', [
    [
      'DS__ds',
      new IndexEntry({
        id: 'ds',
        name: 'DS__ds',
        vfsName: 'DS__ds',
        resourceType: 'notion/data_source',
      }),
    ],
  ])
  await expect(stat(accessor, path, index)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(listed).toEqual(['row'])
})
