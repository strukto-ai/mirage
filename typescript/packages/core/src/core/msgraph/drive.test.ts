import { afterEach, describe, expect, it, vi } from 'vitest'

import { GraphError } from './client.ts'
import { resolveMsGraphConfig } from './config.ts'
import { DriveLoc, copyTree, renameReplace, type DriveRef, type DriveUrl } from './drive.ts'

// drive.ts is one module implementing copy-with-monitor-polling and
// replace-on-409 for OneDrive and SharePoint in both languages, and it had
// no test beside it (issue #1089 item 16b). OneDrive and SharePoint are not
// in the conformance matrix either, so nothing cross-language covered it.
// These mock at the HTTP layer so each case pins a request sequence rather
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
