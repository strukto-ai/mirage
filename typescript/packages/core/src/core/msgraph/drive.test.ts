import { asNumber, parentPath, writeItem } from './drive.ts'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveOneDriveConfig } from '../../accessor/onedrive.ts'
import { PathSpec } from '../../types.ts'
import { GraphDrive } from '../../../tests/fixtures/graph_drive.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { driveLoc } from '../onedrive/client.ts'
import { GraphError } from './client.ts'
import { resolveMsGraphConfig } from './config.ts'
import { DriveLoc, batchTree, copyTree, deltaTree, renameReplace } from './drive.ts'

// drive.ts is one module implementing copy-with-monitor-polling and
// replace-on-409 for OneDrive and SharePoint in both languages, and it had
// no test beside it (issue #1089 item 16b), and nothing cross-language pinned
// its request sequences either. These mock at the HTTP layer so each case pins a request sequence rather
// than an internal call, the same way `test_drive_ops.py`'s twins do.

const BASE = 'https://graph.microsoft.com/v1.0/me/drive'
const CONFLICT = { error: { code: 'nameAlreadyExists', message: 'x' } }

const itemUrl = (path: string, action = ''): string => {
  if (path === '') return `${BASE}/root${action}`
  const stem = `${BASE}/root:/${path}`
  return action !== '' ? `${stem}:${action}` : stem
}
const refPath = (folder = ''): string =>
  folder !== '' ? `/me/drive/root:/${folder}` : '/me/drive/root:'
const staged = (name: string): RegExp =>
  new RegExp(`^${itemUrl(name).replaceAll('.', '\\.')}\\.mirage-[0-9a-f]{32}$`)

function loc(path: string, drive = ''): DriveLoc {
  return new DriveLoc({ drive, path, virtual: `/od/${path}`, url: itemUrl, ref: refPath })
}

const config = resolveMsGraphConfig({ accessToken: 'tok' })

interface Route {
  method: string
  url: string | RegExp
  status?: number
  body?: unknown
  location?: string
}

interface Recorder {
  calls: [string, string][]
  bodies: Record<string, unknown>[]
  pending: () => number
}

// FIFO per (method, url): a route is consumed by the first matching call,
// so registering the same URL twice is how a retry gets a second answer.
function stubFetch(routes: Route[]): Recorder {
  const queue = [...routes]
  const calls: [string, string][] = []
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push([method, url])
      if (typeof init?.body === 'string') {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      }
      const index = queue.findIndex(
        (route) =>
          route.method === method &&
          (typeof route.url === 'string' ? route.url === url : route.url.test(url)),
      )
      if (index === -1) throw new Error(`unstubbed request: ${method} ${url}`)
      const route = queue.splice(index, 1)[0]
      if (route === undefined) throw new Error('unreachable')
      const status = route.status ?? 200
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (route.location !== undefined) headers.Location = route.location
      const payload = route.body === undefined ? null : JSON.stringify(route.body)
      return Promise.resolve(new Response(status === 204 ? null : payload, { status, headers }))
    }),
  )
  return { calls, bodies, pending: () => queue.length }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('copyTree', () => {
  it('polls the monitor the 202 pointed at', async () => {
    const monitor = 'https://monitor.test/op/1'
    const rec = stubFetch([
      { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 202, location: monitor },
      { method: 'GET', url: monitor, body: { status: 'completed' } },
    ])

    await copyTree(config, loc('a.txt'), loc('b.txt'))

    // Without this the case passes when copy returns straight after the
    // 202 and never confirms the operation finished.
    expect(rec.calls).toEqual([
      ['POST', itemUrl('a.txt', '/copy')],
      ['GET', monitor],
    ])
    expect(rec.bodies[0]).toMatchObject({ name: 'b.txt' })
  })

  it('raises the provider code when the monitor reports failed', async () => {
    const monitor = 'https://monitor.test/op/2'
    stubFetch([
      { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 202, location: monitor },
      {
        method: 'GET',
        url: monitor,
        body: { status: 'failed', error: { code: 'generalException', message: 'boom' } },
      },
    ])

    await expect(copyTree(config, loc('a.txt'), loc('b.txt'))).rejects.toMatchObject({
      code: 'generalException',
      status: 500,
    })
  })

  it('lands beside a conflicting file, then deletes it', async () => {
    const monitor = 'https://monitor.test/op/3'
    const retry = 'https://monitor.test/op/3-retry'
    const rec = stubFetch([
      { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 202, location: monitor },
      { method: 'GET', url: monitor, body: { status: 'failed', ...CONFLICT } },
      { method: 'GET', url: itemUrl('a.txt'), body: { id: '1', name: 'a.txt', size: 1, file: {} } },
      { method: 'GET', url: itemUrl('b.txt'), body: { id: '2', name: 'b.txt', size: 1, file: {} } },
      { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 202, location: retry },
      { method: 'GET', url: retry, body: { status: 'completed' } },
      { method: 'DELETE', url: itemUrl('b.txt'), status: 204 },
      { method: 'PATCH', url: staged('b.txt'), body: { id: '3', name: 'b.txt', file: {} } },
    ])

    await copyTree(config, loc('a.txt'), loc('b.txt'))

    expect(rec.pending()).toBe(0)
    expect(rec.calls.filter(([m]) => m === 'DELETE')).toEqual([['DELETE', itemUrl('b.txt')]])
    expect(
      rec.calls.filter(([m, u]) => m === 'POST' && u === itemUrl('a.txt', '/copy')),
    ).toHaveLength(2)
    expect(String(rec.bodies[1]?.name)).toMatch(/^b\.txt\.mirage-[0-9a-f]{32}$/)
    expect(rec.bodies[2]).toEqual({ name: 'b.txt' })
  })

  it.each(['monitor', 'http'] as const)(
    'normalizes a failed replacement retry via %s to 500',
    async (transport) => {
      // The staged copy is the retry: refused, it leaves the file it would
      // have replaced untouched.
      const retry = 'https://monitor.test/op/retry-failed'
      const routes: Route[] =
        transport === 'monitor'
          ? [
              { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 202, location: retry },
              { method: 'GET', url: retry, body: { status: 'failed', ...CONFLICT } },
            ]
          : [{ method: 'POST', url: itemUrl('a.txt', '/copy'), status: 409, body: CONFLICT }]
      const rec = stubFetch([
        { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 409, body: CONFLICT },
        { method: 'GET', url: itemUrl('a.txt'), body: { id: '1', file: {} } },
        { method: 'GET', url: itemUrl('b.txt'), body: { id: '2', file: {} } },
        ...routes,
      ])

      await expect(copyTree(config, loc('a.txt'), loc('b.txt'))).rejects.toMatchObject({
        status: 500,
        code: 'nameAlreadyExists',
      })
      expect(rec.pending()).toBe(0)
      expect(rec.calls.filter(([method]) => method === 'DELETE')).toEqual([])
      expect(rec.calls.filter(([method]) => method === 'POST')).toHaveLength(2)
    },
  )

  it('merges two folders per child and never deletes the destination', async () => {
    const monitor = 'https://monitor.test/op/4'
    const childMonitor = 'https://monitor.test/op/4-child'
    const rec = stubFetch([
      { method: 'POST', url: itemUrl('src', '/copy'), status: 202, location: monitor },
      { method: 'GET', url: monitor, body: { status: 'failed', ...CONFLICT } },
      { method: 'GET', url: itemUrl('src'), body: { id: '1', name: 'src', folder: {} } },
      { method: 'GET', url: itemUrl('dst'), body: { id: '2', name: 'dst', folder: {} } },
      {
        method: 'GET',
        url: itemUrl('src', '/children'),
        body: { value: [{ id: '3', name: 'f.txt', size: 1, file: {} }] },
      },
      { method: 'POST', url: itemUrl('src/f.txt', '/copy'), status: 202, location: childMonitor },
      { method: 'GET', url: childMonitor, body: { status: 'completed' } },
    ])

    await copyTree(config, loc('src'), loc('dst'))

    expect(rec.pending()).toBe(0)
    expect(rec.calls.some(([m]) => m === 'DELETE')).toBe(false)
  })

  it('refuses a file-onto-folder conflict as 409, the status python reports', async () => {
    const monitor = 'https://monitor.test/op/5'
    const rec = stubFetch([
      { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 202, location: monitor },
      { method: 'GET', url: monitor, body: { status: 'failed', ...CONFLICT } },
      { method: 'GET', url: itemUrl('a.txt'), body: { id: '1', name: 'a.txt', size: 1, file: {} } },
      { method: 'GET', url: itemUrl('dst'), body: { id: '2', name: 'dst', folder: {} } },
    ])

    // `copy_once` reports a monitor failure as 500 and a thrown conflict as
    // 409, so re-raising it as it arrived made one refusal carry two
    // statuses; python's `copy_tree` states 409 here outright.
    await expect(copyTree(config, loc('a.txt'), loc('dst'))).rejects.toMatchObject({
      code: 'nameAlreadyExists',
      status: 409,
    })
    expect(rec.calls.some(([m]) => m === 'DELETE')).toBe(false)
  })

  it('names the destination drive in parentReference only across drives', async () => {
    const sameMonitor = 'https://monitor.test/op/6'
    const crossMonitor = 'https://monitor.test/op/7'
    const rec = stubFetch([
      { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 202, location: sameMonitor },
      { method: 'GET', url: sameMonitor, body: { status: 'completed' } },
      { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 202, location: crossMonitor },
      { method: 'GET', url: crossMonitor, body: { status: 'completed' } },
    ])

    await copyTree(config, loc('a.txt', 'A'), loc('sub/b.txt', 'A'))
    await copyTree(config, loc('a.txt', 'A'), loc('sub/b.txt', 'B'))

    expect(rec.bodies[0]?.parentReference).toEqual({ path: '/me/drive/root:/sub' })
    expect(rec.bodies[1]?.parentReference).toEqual({
      path: '/me/drive/root:/sub',
      driveId: 'B',
    })
  })
})

describe('renameReplace', () => {
  it('moves beside a conflicting file, deletes it, then takes its name', async () => {
    const rec = stubFetch([
      { method: 'PATCH', url: itemUrl('a.txt'), status: 409, body: CONFLICT },
      { method: 'GET', url: itemUrl('b.txt'), body: { id: '2', name: 'b.txt', size: 1, file: {} } },
      { method: 'PATCH', url: itemUrl('a.txt'), body: { id: '1' } },
      { method: 'DELETE', url: itemUrl('b.txt'), status: 204 },
      { method: 'PATCH', url: staged('b.txt'), body: { id: '1', name: 'b.txt' } },
    ])

    await renameReplace(config, loc('a.txt'), loc('b.txt'))

    expect(rec.pending()).toBe(0)
    expect(rec.calls.filter(([m]) => m === 'PATCH')).toHaveLength(3)
    expect(String(rec.bodies[1]?.name)).toMatch(/^b\.txt\.mirage-[0-9a-f]{32}$/)
  })

  it('probes an empty folder destination twice, deletes it, then takes its name', async () => {
    // Before the source moves beside it, and again just before its delete.
    const rec = stubFetch([
      { method: 'PATCH', url: itemUrl('src'), status: 409, body: CONFLICT },
      { method: 'GET', url: itemUrl('dst'), body: { id: '2', name: 'dst', folder: {} } },
      { method: 'GET', url: itemUrl('dst', '/children'), body: { value: [] } },
      { method: 'PATCH', url: itemUrl('src'), body: { id: '1' } },
      { method: 'GET', url: itemUrl('dst', '/children'), body: { value: [] } },
      { method: 'DELETE', url: itemUrl('dst'), status: 204 },
      { method: 'PATCH', url: staged('dst'), body: { id: '1', name: 'dst' } },
    ])

    await renameReplace(config, loc('src'), loc('dst'))

    expect(rec.pending()).toBe(0)
  })

  it('keeps the conflict for a non-empty folder destination and deletes nothing', async () => {
    const rec = stubFetch([
      { method: 'PATCH', url: itemUrl('src'), status: 409, body: CONFLICT },
      { method: 'GET', url: itemUrl('dst'), body: { id: '2', name: 'dst', folder: {} } },
      {
        method: 'GET',
        url: itemUrl('dst', '/children'),
        body: { value: [{ id: '3', name: 'kid', size: 0, file: {} }] },
      },
    ])

    await expect(renameReplace(config, loc('src'), loc('dst'))).rejects.toBeInstanceOf(GraphError)
    expect(rec.calls.some(([m]) => m === 'DELETE')).toBe(false)
    expect(rec.calls.filter(([m]) => m === 'PATCH')).toHaveLength(1)
  })

  it('omits parentReference when the parent and drive are unchanged', async () => {
    const rec = stubFetch([{ method: 'PATCH', url: itemUrl('a.txt'), body: { id: '1' } }])

    await renameReplace(config, loc('a.txt'), loc('b.txt'))

    expect(rec.bodies[0]).toEqual({ name: 'b.txt' })
  })
})

function selected(url: string): string {
  const target = new URL(url)
  target.searchParams.set('$select', 'id,folder')
  return target.toString()
}

function row(id: string, name: string, parent: string, facets: Record<string, unknown> = {}) {
  return { id, name, parentReference: { id: parent }, ...facets }
}

describe('deltaTree', () => {
  it('places every item by its parents', async () => {
    const feed = [
      row('T', 'reports', 'OUT', { folder: { childCount: 2 } }),
      row('a', 'a.txt', 'A', { size: 3, file: {}, cTag: 'c1' }),
      row('A', 'sub', 'T', { folder: { childCount: 1 } }),
      row('b', 'b.txt', 'T', { size: 1, file: {}, cTag: 'c2' }),
      row('b', 'b.txt', 'T', { size: 5, file: {}, cTag: 'c3' }),
      row('P', 'notes', 'T', { package: { type: 'oneNote' }, size: 9 }),
      row('p', 'page.one', 'P', { size: 2, file: {}, cTag: 'c4' }),
      row('x', 'gone.txt', 'T', { file: {}, deleted: {} }),
      row('o', 'lost.txt', 'NOWHERE', { size: 1, file: {}, cTag: 'c5' }),
    ]
    const recorder = stubFetch([
      { method: 'GET', url: selected(itemUrl('team/reports')), body: { id: 'T', folder: {} } },
      { method: 'GET', url: itemUrl('team/reports', '/delta'), body: { value: feed } },
    ])
    const found = await deltaTree(config, loc('team/reports'))
    expect(recorder.pending()).toBe(0)
    expect([...(found?.keys() ?? [])].sort()).toEqual(['b.txt', 'notes', 'sub', 'sub/a.txt'])
    expect(found?.get('b.txt')?.size).toBe(5)
    expect(found?.get('sub')?.extra.child_count).toBe(1)
    expect(found?.get('sub/a.txt')?.fingerprint).toBe('c1')
    expect(found?.get('notes')?.size).toBe(9)
  })

  it('ignores a parent loop', async () => {
    stubFetch([
      { method: 'GET', url: selected(itemUrl('')), body: { id: 'T', folder: {} } },
      {
        method: 'GET',
        url: itemUrl('', '/delta'),
        body: {
          value: [
            row('T', '', '', { root: {}, folder: {} }),
            row('X', 'x', 'Y', { folder: {} }),
            row('Y', 'y', 'X', { folder: {} }),
            row('f', 'f.txt', 'X', { size: 1, file: {}, cTag: 'c1' }),
            row('g', 'g.txt', 'T', { size: 1, file: {}, cTag: 'c2' }),
          ],
        },
      },
    ])
    const found = await deltaTree(config, loc(''))
    expect([...(found?.keys() ?? [])]).toEqual(['g.txt'])
  })

  it.each<[string, Route]>([
    [
      'nothing',
      {
        method: 'GET',
        url: selected(itemUrl('f')),
        status: 404,
        body: { error: { code: 'itemNotFound', message: 'gone' } },
      },
    ],
    ['a file', { method: 'GET', url: selected(itemUrl('f')), body: { id: 'F', file: {} } }],
  ])('leaves %s to the walk', async (_name, route) => {
    const recorder = stubFetch([route])
    expect(await deltaTree(config, loc('f'))).toBeNull()
    expect(recorder.calls).toHaveLength(1)
  })

  it('leaves a folder from another drive to the walk', async () => {
    stubFetch([
      { method: 'GET', url: selected(itemUrl('')), body: { id: 'T', folder: {} } },
      {
        method: 'GET',
        url: itemUrl('', '/delta'),
        body: {
          value: [
            row('T', '', '', { root: {}, folder: {} }),
            row('S', 'shared', 'T', { folder: {}, remoteItem: { folder: {} } }),
            row('g', 'g.txt', 'T', { size: 1, file: {}, cTag: 'c1' }),
          ],
        },
      },
    ])
    expect(await deltaTree(config, loc(''))).toBeNull()
  })

  it('leaves a refused feed to the walk', async () => {
    stubFetch([
      { method: 'GET', url: selected(itemUrl('f')), body: { id: 'T', folder: {} } },
      {
        method: 'GET',
        url: itemUrl('f', '/delta'),
        status: 400,
        body: { error: { code: 'invalidRequest', message: 'no delta here' } },
      },
    ])
    expect(await deltaTree(config, loc('f'))).toBeNull()
  })

  it('leaves a feed without cTags to the walk', async () => {
    stubFetch([
      { method: 'GET', url: selected(itemUrl('')), body: { id: 'T', folder: {} } },
      {
        method: 'GET',
        url: itemUrl('', '/delta'),
        body: {
          value: [
            row('T', '', '', { root: {}, folder: {} }),
            row('a', 'a.txt', 'T', { size: 1, file: {}, cTag: 'c1' }),
            row('b', 'b.txt', 'T', { size: 1, file: {} }),
          ],
        },
      },
    ])
    expect(await deltaTree(config, loc(''))).toBeNull()
  })

  it('leaves a feed of another folder to the walk', async () => {
    stubFetch([
      { method: 'GET', url: selected(itemUrl('team/reports')), body: { id: 'T', folder: {} } },
      {
        method: 'GET',
        url: itemUrl('team/reports', '/delta'),
        body: {
          value: [
            row('N', 'reports', 'OUT', { folder: {} }),
            row('a', 'a.txt', 'N', { size: 1, file: {}, cTag: 'c1' }),
          ],
        },
      },
    ])
    expect(await deltaTree(config, loc('team/reports'))).toBeNull()
  })

  it('raises what Graph refuses', async () => {
    stubFetch([
      {
        method: 'GET',
        url: selected(itemUrl('f')),
        status: 403,
        body: { error: { code: 'accessDenied', message: 'no' } },
      },
    ])
    await expect(deltaTree(config, loc('f'))).rejects.toBeInstanceOf(GraphError)
  })
})

const BATCH = 'https://graph.microsoft.com/v1.0/$batch'

function children(path: string): string {
  return itemUrl(path, '/children')
}

function relative(path: string): string {
  return children(path).slice('https://graph.microsoft.com/v1.0'.length)
}

function batched(...bodies: unknown[]): unknown {
  return { responses: bodies.map((body, i) => ({ id: String(i), status: 200, body })) }
}

function asked(...paths: string[]): unknown {
  return {
    requests: paths.map((path, i) => ({ id: String(i), method: 'GET', url: relative(path) })),
  }
}

const TOP = [
  row('A', 'a', 'T', { folder: { childCount: 2 } }),
  row('B', 'b', 'T', { folder: { childCount: 1 } }),
  row('f', 'f.txt', 'T', { size: 1, file: {}, cTag: 'cf' }),
]
const UNDER_A = [
  row('C', 'c', 'A', { folder: { childCount: 1 } }),
  row('x', 'x.txt', 'A', { size: 2, file: {}, cTag: 'cx' }),
]
const UNDER_B = [row('y', 'y.txt', 'B', { size: 3, file: {}, cTag: 'cy' })]
const UNDER_C = [row('z', 'z.txt', 'C', { size: 4, file: {}, cTag: 'cz' })]

const SPEC = PathSpec.fromStrPath('/od/top', 'top')

describe('batchTree', () => {
  it('lists a level per batch', async () => {
    const rec = stubFetch([
      { method: 'GET', url: children('top'), body: { value: TOP } },
      { method: 'POST', url: BATCH, body: batched({ value: UNDER_A }, { value: UNDER_B }) },
      { method: 'POST', url: BATCH, body: batched({ value: UNDER_C }) },
    ])
    const found = await batchTree(config, loc('top'), SPEC)
    expect(rec.pending()).toBe(0)
    expect([...(found?.keys() ?? [])].sort()).toEqual([
      'a',
      'a/c',
      'a/c/z.txt',
      'a/x.txt',
      'b',
      'b/y.txt',
      'f.txt',
    ])
    expect(found?.get('a/c/z.txt')?.fingerprint).toBe('cz')
    expect(found?.get('a')?.extra.child_count).toBe(2)
    expect(rec.bodies).toEqual([asked('top/a', 'top/b'), asked('top/a/c')])
  })

  // Twin of test_batch_tree_pages_a_listing_no_further_than_a_walks_limit.
  it('pages a listing no further than a walk limit', async () => {
    const rest = `${children('top/a')}?page=2`
    const more = `${children('top/a')}?page=3`
    const file = (i: number) =>
      row(`x${String(i)}`, `x${String(i)}.txt`, 'A', { size: 1, file: {} })
    const rec = stubFetch([
      {
        method: 'GET',
        url: children('top'),
        body: { value: [row('A', 'a', 'T', { folder: { childCount: 4 } })] },
      },
      { method: 'POST', url: BATCH, body: batched({ value: [], '@odata.nextLink': rest }) },
      { method: 'GET', url: rest, body: { value: [0, 1, 2].map(file), '@odata.nextLink': more } },
      { method: 'GET', url: more, body: { value: [file(3)] } },
    ])
    expect(await batchTree(config, loc('top'), SPEC, 3)).toBeNull()
    expect(rec.pending()).toBe(1)
  })

  it('splits a wide level', async () => {
    const names = Array.from({ length: 25 }, (_, i) => `d${String(i).padStart(2, '0')}`)
    const rec = stubFetch([
      {
        method: 'GET',
        url: children('top'),
        body: { value: names.map((n) => row(n, n, 'T', { folder: {} })) },
      },
      {
        method: 'POST',
        url: BATCH,
        body: batched(...names.slice(0, 20).map(() => ({ value: [] }))),
      },
      { method: 'POST', url: BATCH, body: batched(...names.slice(20).map(() => ({ value: [] }))) },
    ])
    const found = await batchTree(config, loc('top'), SPEC)
    expect([...(found?.keys() ?? [])].sort()).toEqual(names)
    expect(rec.bodies.map((b) => (b.requests as unknown[]).length)).toEqual([20, 5])
  })

  it('waits once for the longest Retry-After before asking unanswered listings alone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const rec = stubFetch([
        { method: 'GET', url: children('top'), body: { value: TOP } },
        {
          method: 'POST',
          url: BATCH,
          body: {
            responses: [
              { id: '0', status: 429, headers: { 'Retry-After': '2' }, body: {} },
              { id: '1', status: 429, headers: { 'Retry-After': '3' }, body: {} },
            ],
          },
        },
        { method: 'GET', url: children('top/a'), body: { value: UNDER_A } },
        { method: 'GET', url: children('top/b'), body: { value: UNDER_B } },
        { method: 'POST', url: BATCH, body: batched({ value: UNDER_C }) },
      ])
      const pending = batchTree(config, loc('top'), SPEC)
      await vi.advanceTimersByTimeAsync(2900)
      expect(rec.calls).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(200)
      expect(rec.calls).toHaveLength(5)
      const found = await pending
      expect(found?.has('a/c/z.txt')).toBe(true)
      expect(found?.has('b/y.txt')).toBe(true)
      expect(rec.pending()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the walk a folder the account may not open', async () => {
    const denied = { error: { code: 'accessDenied', message: 'no' } }
    stubFetch([
      { method: 'GET', url: children('top'), body: { value: TOP } },
      {
        method: 'POST',
        url: BATCH,
        body: {
          responses: [
            { id: '0', status: 200, body: { value: [] } },
            { id: '1', status: 403, body: denied },
          ],
        },
      },
      { method: 'GET', url: children('top/b'), status: 403, body: denied },
    ])
    expect(await batchTree(config, loc('top'), SPEC)).toBeNull()
  })

  it("reads a listing's later pages", async () => {
    const next = 'https://graph.microsoft.com/v1.0/next-page'
    const rec = stubFetch([
      { method: 'GET', url: children('top'), body: { value: TOP } },
      {
        method: 'POST',
        url: BATCH,
        body: batched({ value: [] }, { value: [], '@odata.nextLink': next }),
      },
      { method: 'GET', url: next, body: { value: UNDER_B } },
    ])
    const found = await batchTree(config, loc('top'), SPEC)
    expect(found?.get('b/y.txt')?.size).toBe(3)
    expect(rec.pending()).toBe(0)
  })

  it('leaves the walk a folder gone below', async () => {
    const gone = { error: { code: 'itemNotFound', message: 'gone' } }
    stubFetch([
      { method: 'GET', url: children('top'), body: { value: TOP } },
      {
        method: 'POST',
        url: BATCH,
        body: {
          responses: [
            { id: '0', status: 200, body: { value: [] } },
            { id: '1', status: 404, body: gone },
          ],
        },
      },
      { method: 'GET', url: children('top/b'), status: 404, body: gone },
    ])
    expect(await batchTree(config, loc('top'), SPEC)).toBeNull()
  })

  it('leaves the walk a refused batch', async () => {
    stubFetch([
      { method: 'GET', url: children('top'), body: { value: TOP } },
      {
        method: 'POST',
        url: BATCH,
        status: 400,
        body: { error: { code: 'invalidRequest', message: 'no batching here' } },
      },
    ])
    expect(await batchTree(config, loc('top'), SPEC)).toBeNull()
  })
})

async function* streamed(data: Uint8Array): AsyncGenerator<Uint8Array> {
  await Promise.resolve()
  yield data
}

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'an upload bounds parts and cancels a failed session (fail %s, streamed %s)',
  async (fail, stream) => {
    const upload = 'https://upload.test/session'
    const total = 5 * 1024 * 1024
    const part = 10 * 327680
    const calls: RequestInit[] = []
    let puts = 0
    let cancelled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        await Promise.resolve()
        if (init.method === 'POST') return Response.json({ uploadUrl: upload })
        if (init.method === 'DELETE') {
          cancelled = true
          return new Response(null, { status: 204 })
        }
        calls.push(init)
        puts++
        if (puts === 1) return Response.json({ nextExpectedRanges: [`${String(part)}-`] })
        return Response.json(fail ? { error: { code: 'badRequest' } } : { id: 'file' }, {
          status: fail ? 400 : 201,
        })
      }),
    )
    const data = new Uint8Array(total)
    const uploading = writeItem(config, loc('file'), stream ? streamed(data) : data)
    if (fail) await expect(uploading).rejects.toBeInstanceOf(GraphError)
    else expect(await uploading).toBe(total)
    expect(calls.map((c) => (c.body as Uint8Array).length)).toEqual([part, total - part])
    expect(calls.every((c) => !new Headers(c.headers).has('Authorization'))).toBe(true)
    expect(cancelled).toBe(fail)
  },
)

it('stream source failure never starts an upload', async () => {
  const fetching = vi.fn()
  vi.stubGlobal('fetch', fetching)
  async function* broken(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    yield new Uint8Array([1])
    throw new Error('source failed')
  }
  await expect(writeItem(config, loc('file'), broken())).rejects.toThrow('source failed')
  expect(fetching).not.toHaveBeenCalled()
})

vi.mock('./paths.ts', () => ({ checkItem: vi.fn().mockResolvedValue(null) }))

it.each([true, -1, 0.5, '12'])('keeps an invalid Graph count unknown', (value) => {
  expect(asNumber(value)).toBeNull()
})

it('resolves the parent of a directory with a trailing slash', () => {
  expect(parentPath('parent/nested/')).toBe('parent')
})

describe('a replace on the Graph fake', () => {
  const ITEM = '/me/drive/*rest'
  const DENIED = { error: { code: 'accessDenied', message: 'Access denied.' } }
  let origin: string
  let drive: GraphDrive

  beforeAll(async () => {
    origin = await serve('onedrive')
  }, 30_000)

  beforeEach(async () => {
    drive = new GraphDrive(origin)
    await drive.reset()
  })

  afterEach(async () => {
    await drive.run.close()
  })

  async function names(folder = ''): Promise<string[]> {
    const at = folder !== '' ? `root:/${folder}:/children` : 'root/children'
    const listed = await drive.run.call<{ value: { name: string }[] }>('GET', `/me/drive/${at}`)
    return listed.value.map((child) => child.name).sort()
  }

  async function replaced(op: typeof renameReplace | typeof copyTree, src: string, dst: string) {
    const odConfig = resolveOneDriveConfig({
      accessToken: drive.token,
      graphBaseUrl: drive.run.url,
    })
    await op(odConfig, driveLoc(odConfig, src), driveLoc(odConfig, dst), `/${src}`, `/${dst}`)
  }

  function text(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes)
  }

  it.each([
    ['rename', renameReplace],
    ['copy', copyTree],
  ] as const)('a %s lands beside and leaves no staged name', async (name, op) => {
    await drive.write('a.txt', 'mine')
    await drive.write('b.txt', 'theirs')
    await replaced(op, 'a.txt', 'b.txt')
    expect(await names()).toEqual(name === 'copy' ? ['a.txt', 'b.txt'] : ['b.txt'])
    expect(text(await drive.content('b.txt'))).toBe('mine')
  })

  it('a refused staged move keeps the destination', async () => {
    // The move meets the taken name, then the staged move is refused (a
    // view-only source, say): nothing was deleted yet.
    await drive.write('a.txt', 'mine')
    await drive.write('b.txt', 'theirs')
    await drive.run.answerNext('PATCH', ITEM, 409, CONFLICT)
    await drive.run.answerNext('PATCH', ITEM, 403, DENIED)
    await expect(replaced(renameReplace, 'a.txt', 'b.txt')).rejects.toBeInstanceOf(GraphError)
    expect(await names()).toEqual(['a.txt', 'b.txt'])
    expect(text(await drive.content('b.txt'))).toBe('theirs')
  })

  it.each([
    ['rename', renameReplace],
    ['copy', copyTree],
  ] as const)('a refused delete takes the landed %s back', async (_name, op) => {
    await drive.write('sub/a.txt', 'mine')
    await drive.write('b.txt', 'theirs')
    await drive.run.answerNext('DELETE', ITEM, 403, DENIED)
    await expect(replaced(op, 'sub/a.txt', 'b.txt')).rejects.toBeInstanceOf(GraphError)
    expect(await names()).toEqual(['b.txt', 'sub'])
    expect(await names('sub')).toEqual(['a.txt'])
    expect(text(await drive.content('b.txt'))).toBe('theirs')
  })

  it('keeps a folder given a child while the source moves', async () => {
    // Another client writes into the empty folder while the source moves
    // beside it (the move after the one that met the name): the probe made
    // just before the delete sees the child, so the folder stays and the
    // source goes back.
    await drive.write('src/x.txt', 'x')
    await drive.run.call('POST', '/me/drive/root/children', {
      json: { name: 'dst', folder: {} },
    })
    await drive.run.beforeNext([['PATCH', ITEM]], () =>
      drive.run.beforeNext([['PATCH', ITEM]], () => drive.write('dst/late.txt', 'late')),
    )
    await expect(replaced(renameReplace, 'src', 'dst')).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    })
    expect(await names()).toEqual(['dst', 'src'])
    expect(await names('dst')).toEqual(['late.txt'])
    expect(await names('src')).toEqual(['x.txt'])
  })
})
