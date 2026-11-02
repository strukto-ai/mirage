import { PathSpec } from '@struktoai/mirage-core/types'
import { sleep } from '@struktoai/mirage-core/utils/abort'
import type * as Abort from '@struktoai/mirage-core/utils/abort'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { ROOT, multistatus } from '../../../tests/core/nextcloud/mock.ts'
import { ATTEMPTS, FENCE, rmdir } from './rmdir.ts'

vi.mock('@struktoai/mirage-core/utils/abort', async (importOriginal) => ({
  ...(await importOriginal<typeof Abort>()),
  sleep: vi.fn(() => Promise.resolve()),
}))

const HREF = '/remote.php/dav/files/user'

/**
 * One Nextcloud folder as rmdir sees it: its children, a modified time in
 * whole seconds that every arrival moves to the server's clock, and
 * `If-Unmodified-Since` honoured on DELETE. Mirrors Python's `FakeFolder`.
 */
class FakeFolder {
  children: string[]
  clock = Date.UTC(2026, 10, 2, 12, 0, 0)
  modified: number
  exists = true
  settable = true
  locked = false
  busy = false
  calls: { method: string; url: string; headers: Record<string, string> }[] = []
  before = new Map<string, () => void>()

  constructor(
    readonly name: string,
    children: string[] = [],
    age = 60_000,
  ) {
    this.children = children
    this.modified = whole(this.clock - age)
  }

  arrive(child: string): void {
    this.children.push(child)
    this.modified = whole(this.clock)
  }

  answer(status: number, body: string | null = null): Response {
    return new Response(body, { status, headers: { Date: new Date(this.clock).toUTCString() } })
  }

  listing(): string {
    const own = `${HREF}/${encodeURIComponent(this.name)}/`
    const rows = [
      `<d:response><d:href>${own}</d:href><d:propstat><d:prop>` +
        `<d:getlastmodified>${new Date(this.modified).toUTCString()}</d:getlastmodified></d:prop>` +
        '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
      ...this.children.map(
        (c) => `<d:response><d:href>${own}${encodeURIComponent(c)}</d:href></d:response>`,
      ),
    ]
    return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${rows.join('')}</d:multistatus>`
  }

  fetch = (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET'
    const headers = { ...(init.headers as Record<string, string>) }
    this.calls.push({ method, url, headers })
    this.clock += 300
    const hook = this.before.get(method)
    if (hook !== undefined) {
      this.before.delete(method)
      hook()
    }
    return Promise.resolve(this.respond(method, headers, init.body))
  }

  respond(method: string, headers: Record<string, string>, body: unknown): Response {
    if (!this.exists) return this.answer(404)
    if (method === 'PROPFIND') {
      if (this.busy) this.modified = whole(this.clock)
      return this.answer(207, this.listing())
    }
    if (method === 'PROPPATCH') {
      if (!this.settable) return this.answer(207, multistatus('403 Forbidden', '<d:lastmodified/>'))
      const seconds = /<d:lastmodified>(\d+)</.exec(String(body))
      this.modified = Number(seconds?.[1]) * 1000
      return this.answer(207, multistatus('200 OK', '<d:lastmodified/>'))
    }
    if (this.locked) return this.answer(423)
    if (this.modified > Date.parse(headers['If-Unmodified-Since'] ?? '')) return this.answer(412)
    this.exists = false
    return this.answer(204)
  }

  methods(): string[] {
    return this.calls.map((call) => call.method)
  }
}

function whole(ms: number): number {
  return Math.floor(ms / 1000) * 1000
}

async function removing(folder: FakeFolder, path = `/${folder.name}`): Promise<void> {
  vi.stubGlobal('fetch', folder.fetch)
  await rmdir(new NextcloudAccessor({ url: `${ROOT}/` }), PathSpec.fromStrPath(path))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(sleep).mockClear()
})

describe('nextcloud rmdir', () => {
  it('removes an empty collection in two requests', async () => {
    const folder = new FakeFolder('dir')
    await removing(folder)
    expect(folder.exists).toBe(false)
    expect(folder.methods()).toEqual(['PROPFIND', 'DELETE'])
    expect(folder.calls[1]?.url).toBe(`${ROOT}/dir/`)
    expect(Date.parse(folder.calls[1]?.headers['If-Unmodified-Since'] ?? '')).toBe(folder.modified)
  })

  it('refuses a collection holding a child', async () => {
    const folder = new FakeFolder('dir', ['a.txt'])
    await expect(removing(folder)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(folder.exists).toBe(true)
    expect(folder.methods()).toEqual(['PROPFIND'])
  })

  it('keeps a child created after the check', async () => {
    const folder = new FakeFolder('dir')
    folder.before.set('DELETE', () => {
      folder.arrive('late.txt')
    })
    await expect(removing(folder)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(folder.children).toEqual(['late.txt'])
    expect(folder.methods()).toEqual(['PROPFIND', 'DELETE', 'PROPFIND'])
  })

  it('checks again after a child came and went', async () => {
    const folder = new FakeFolder('dir')
    folder.before.set('DELETE', () => {
      folder.arrive('tmp')
      folder.children = []
    })
    await removing(folder)
    expect(folder.exists).toBe(false)
    expect(folder.methods()).toEqual([
      'PROPFIND',
      'DELETE',
      'PROPFIND',
      'PROPPATCH',
      'PROPFIND',
      'DELETE',
    ])
  })

  it.each([0, 1000, -86_400_000])(
    'backdates a fresh or future collection (age %i ms)',
    async (age) => {
      const folder = new FakeFolder('dir', [], age)
      await removing(folder)
      expect(folder.exists).toBe(false)
      expect(folder.methods()).toEqual(['PROPFIND', 'PROPPATCH', 'PROPFIND', 'DELETE'])
    },
  )

  it('keeps a child created in the backdated second', async () => {
    const folder = new FakeFolder('dir', [], 0)
    folder.before.set('DELETE', () => {
      folder.arrive('late.txt')
    })
    await expect(removing(folder)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(folder.children).toEqual(['late.txt'])
  })

  it('waits out a fresh collection that cannot be backdated', async () => {
    const folder = new FakeFolder('dir', [], 0)
    folder.settable = false
    folder.before.set('PROPPATCH', () => {
      folder.clock += FENCE
    })
    await removing(folder)
    expect(folder.exists).toBe(false)
    expect(sleep).toHaveBeenCalledOnce()
    expect(sleep).toHaveBeenCalledWith(FENCE)
  })

  it('is busy when the collection keeps changing', async () => {
    const folder = new FakeFolder('dir')
    folder.settable = false
    folder.busy = true
    await expect(removing(folder)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(folder.exists).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(ATTEMPTS)
  })

  it.each<[Partial<FakeFolder>, string]>([
    [{ exists: false }, 'ENOENT'],
    [{ locked: true }, 'EBUSY'],
  ])('maps a server refusal to an errno (%o)', async (setup, code) => {
    const folder = Object.assign(new FakeFolder('dir'), setup)
    await expect(removing(folder)).rejects.toMatchObject({ code })
  })

  it('does not take a percent-encoded name for its own child', async () => {
    const folder = new FakeFolder('a b#c')
    await removing(folder)
    expect(folder.exists).toBe(false)
    expect(folder.calls[0]?.url).toBe(`${ROOT}/a%20b%23c/`)
  })
})
