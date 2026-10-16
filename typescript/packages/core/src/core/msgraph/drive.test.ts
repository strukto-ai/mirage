import { afterEach, describe, expect, it, vi } from 'vitest'

import { PathSpec } from '../../types.ts'
import { GraphError } from './client.ts'
import { resolveMsGraphConfig } from './config.ts'
import {
  DriveLoc,
  batchTree,
  copyTree,
  deltaTree,
  renameReplace,
  type DriveRef,
  type DriveUrl,
} from './drive.ts'

// drive.ts is one module implementing copy-with-monitor-polling and
// replace-on-409 for OneDrive and SharePoint in both languages, and it had
// no test beside it (issue #1089 item 16b), and nothing cross-language pinned
// its request sequences either. These mock at the HTTP layer so each case pins a request sequence rather
// than an internal call, the same way `test_drive_ops.py`'s twins do.

const BASE = 'https://graph.microsoft.com/v1.0/me/drive'
const CONFLICT = { error: { code: 'nameAlreadyExists', message: 'x' } }

const itemUrl: DriveUrl = (path, action = '') => {
  if (path === '') return `${BASE}/root${action}`
  const stem = `${BASE}/root:/${path}`
  return action !== '' ? `${stem}:${action}` : stem
}
const refPath: DriveRef = (folder = '') =>
  folder !== '' ? `/me/drive/root:/${folder}` : '/me/drive/root:'

function loc(path: string, drive = ''): DriveLoc {
  return new DriveLoc({ drive, path, virtual: `/od/${path}`, url: itemUrl, ref: refPath })
}

const config = resolveMsGraphConfig({ accessToken: 'tok' })

interface Route {
  method: string
  url: string
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
      const index = queue.findIndex((route) => route.method === method && route.url === url)
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

  it('deletes a conflicting file destination and copies again', async () => {
    const monitor = 'https://monitor.test/op/3'
    const retry = 'https://monitor.test/op/3-retry'
    const rec = stubFetch([
      { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 202, location: monitor },
      { method: 'GET', url: monitor, body: { status: 'failed', ...CONFLICT } },
      { method: 'GET', url: itemUrl('a.txt'), body: { id: '1', name: 'a.txt', size: 1, file: {} } },
      { method: 'GET', url: itemUrl('b.txt'), body: { id: '2', name: 'b.txt', size: 1, file: {} } },
      { method: 'DELETE', url: itemUrl('b.txt'), status: 204 },
      { method: 'POST', url: itemUrl('a.txt', '/copy'), status: 202, location: retry },
      { method: 'GET', url: retry, body: { status: 'completed' } },
    ])

    await copyTree(config, loc('a.txt'), loc('b.txt'))

    expect(rec.pending()).toBe(0)
    expect(rec.calls.filter(([m]) => m === 'DELETE')).toEqual([['DELETE', itemUrl('b.txt')]])
    expect(
      rec.calls.filter(([m, u]) => m === 'POST' && u === itemUrl('a.txt', '/copy')),
    ).toHaveLength(2)
  })

  it.each(['monitor', 'http'] as const)(
    'normalizes a failed replacement retry via %s to 500',
    async (transport) => {
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
        { method: 'DELETE', url: itemUrl('b.txt'), status: 204 },
        ...routes,
      ])

      await expect(copyTree(config, loc('a.txt'), loc('b.txt'))).rejects.toMatchObject({
        status: 500,
        code: 'nameAlreadyExists',
      })
      expect(rec.pending()).toBe(0)
      expect(rec.calls.filter(([method]) => method === 'DELETE')).toEqual([
        ['DELETE', itemUrl('b.txt')],
      ])
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
  it('deletes a conflicting file destination and patches again', async () => {
    const rec = stubFetch([
      { method: 'PATCH', url: itemUrl('a.txt'), status: 409, body: CONFLICT },
      { method: 'GET', url: itemUrl('b.txt'), body: { id: '2', name: 'b.txt', size: 1, file: {} } },
      { method: 'DELETE', url: itemUrl('b.txt'), status: 204 },
      { method: 'PATCH', url: itemUrl('a.txt'), body: { id: '1' } },
    ])

    await renameReplace(config, loc('a.txt'), loc('b.txt'))

    expect(rec.pending()).toBe(0)
    expect(rec.calls.filter(([m]) => m === 'PATCH')).toHaveLength(2)
  })

  it('probes an empty folder destination, deletes it, and patches again', async () => {
    const rec = stubFetch([
      { method: 'PATCH', url: itemUrl('src'), status: 409, body: CONFLICT },
      { method: 'GET', url: itemUrl('dst'), body: { id: '2', name: 'dst', folder: {} } },
      { method: 'GET', url: itemUrl('dst', '/children'), body: { value: [] } },
      { method: 'DELETE', url: itemUrl('dst'), status: 204 },
      { method: 'PATCH', url: itemUrl('src'), body: { id: '1' } },
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

  it('asks a listing the batch left unanswered on its own, after its wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const rec = stubFetch([
        { method: 'GET', url: children('top'), body: { value: TOP } },
        {
          method: 'POST',
          url: BATCH,
          body: {
            responses: [
              { id: '0', status: 200, body: { value: [] } },
              { id: '1', status: 429, headers: { 'Retry-After': '3' }, body: {} },
            ],
          },
        },
        { method: 'GET', url: children('top/b'), body: { value: UNDER_B } },
      ])
      const pending = batchTree(config, loc('top'), SPEC)
      await vi.advanceTimersByTimeAsync(2900)
      expect(rec.calls.some(([, url]) => url === children('top/b'))).toBe(false)
      await vi.advanceTimersByTimeAsync(200)
      const found = await pending
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
