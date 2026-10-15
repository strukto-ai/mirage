import { expect, it } from 'vitest'
import { NotionVFSBase } from '../../vfs/notion/notion.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { NotionTransport } from './client.ts'

const ROW = {
  id: 'row',
  parent: { data_source_id: 'ds' },
  properties: { Name: { type: 'title', title: [{ plain_text: 'Row' }] } },
}

// Answers the listings above a row (the database, its data source, the row's
// child pages) and hands each page fetch to `page`; records every call.
function transport(
  page: (args: Record<string, unknown>) => Record<string, unknown>,
  calls: [string, Record<string, unknown>][],
  children: Record<string, unknown>[] = [
    { id: 'child', type: 'child_page', child_page: { title: 'Child' } },
  ],
): NotionTransport {
  return {
    callTool: (name, args) => {
      calls.push([name, args])
      if (name === 'API-post-search') {
        return Promise.resolve({
          results: [{ id: 'ds', object: 'data_source', parent: { database_id: 'db' } }],
          has_more: false,
          next_cursor: null,
        })
      }
      if (name === 'API-retrieve-a-database') {
        return Promise.resolve({
          id: 'db',
          title: [{ plain_text: 'DB' }],
          data_sources: [{ id: 'ds', name: 'DS' }],
        })
      }
      if (name === 'API-retrieve-a-data-source') return Promise.resolve({ id: 'ds' })
      if (name === 'API-retrieve-block-children') {
        return Promise.resolve({ results: children, has_more: false, next_cursor: null })
      }
      return Promise.resolve(page(args))
    },
  }
}

function mounted(through: NotionTransport): Workspace {
  return new Workspace({ '/': new NotionVFSBase({ accessor: { transport: through } }) })
}

const routes = [
  ['stat', ''],
  ['stat', '/page.json'],
  ['readdir', ''],
  ['read', '/page.json'],
  ['stat', '/Child__child'],
  ['read', '/Child__child/page.json'],
  ['readdir', '/Child__child'],
] as const

it.each(['title', 'parent', 'trash', 'archived'])(
  'validates a row at every entry point: %s',
  async (change) => {
    for (const [op, suffix] of routes) {
      const calls: [string, Record<string, unknown>][] = []
      const page = () => ({
        ...ROW,
        parent: { data_source_id: change === 'parent' ? 'other' : 'ds' },
        in_trash: change === 'trash',
        archived: change === 'archived',
      })
      const label = change === 'title' ? 'Wrong' : 'Row'
      const path = `/databases/DB__db/DS__ds/${label}__row${suffix}`
      await expect(mounted(transport(page, calls)).dispatch(op, path)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(calls.some(([name]) => name === 'API-retrieve-a-page')).toBe(true)
    }
  },
)

it('keeps the containing row identity when reading a child', async () => {
  const calls: [string, Record<string, unknown>][] = []
  const page = (args: Record<string, unknown>) => (args.page_id === 'row' ? ROW : { id: 'child' })
  await mounted(transport(page, calls)).dispatch(
    'read',
    '/databases/DB__db/DS__ds/Row__row/Child__child/page.json',
  )
  const pages = calls.filter(([name]) => name === 'API-retrieve-a-page').map(([, a]) => a.page_id)
  expect(pages).toContain('row')
  expect(pages.at(-1)).toBe('child')
})

it('rejects a missing child beneath a valid row', async () => {
  const calls: [string, Record<string, unknown>][] = []
  await expect(
    mounted(transport(() => ROW, calls, [])).dispatch(
      'stat',
      '/databases/DB__db/DS__ds/Row__row/Fabricated__missing',
    ),
  ).rejects.toMatchObject({ code: 'ENOENT' })
  const listed = calls.filter(([name]) => name === 'API-retrieve-block-children')
  expect(listed.map(([, a]) => a.block_id)).toEqual(['row'])
})
