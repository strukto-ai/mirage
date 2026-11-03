import { PathSpec } from '@struktoai/mirage-core/types'
import { sleep } from '@struktoai/mirage-core/utils/abort'
import type * as Abort from '@struktoai/mirage-core/utils/abort'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { FakeFolder, ROOT } from '../../../tests/core/nextcloud/mock.ts'
import { ATTEMPTS, FENCE } from './constants.ts'
import { remove, rmR } from './rm.ts'

vi.mock('@struktoai/mirage-core/utils/abort', async (importOriginal) => ({
  ...(await importOriginal<typeof Abort>()),
  sleep: vi.fn(() => Promise.resolve()),
}))

function removing(folder: FakeFolder, empty = true): Promise<void> {
  vi.stubGlobal('fetch', folder.fetch)
  return remove(
    new NextcloudAccessor({ url: `${ROOT}/` }),
    PathSpec.fromStrPath(`/${folder.name}`),
    empty,
  )
}

function ageing(folder: FakeFolder): void {
  vi.mocked(sleep).mockImplementation((ms) => {
    folder.wait(ms)
    return new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(sleep).mockReset()
  vi.mocked(sleep).mockImplementation(() => Promise.resolve())
})

describe('nextcloud fenced removal', () => {
  it.each([true, false])('removes an old collection in two requests (empty %s)', async (empty) => {
    const folder = new FakeFolder('dir')
    await removing(folder, empty)
    expect(folder.exists).toBe(false)
    expect(folder.methods()).toEqual(['PROPFIND', 'DELETE'])
    expect(folder.calls[1]?.url).toBe(`${ROOT}/dir/`)
    expect(Date.parse(folder.calls[1]?.headers['If-Unmodified-Since'] ?? '')).toBe(folder.modified)
  })

  it('refuses a collection holding a child when it must be empty', async () => {
    const folder = new FakeFolder('dir', ['a.txt'])
    await expect(removing(folder)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(folder.exists).toBe(true)
    expect(folder.methods()).toEqual(['PROPFIND'])
  })

  it('keeps a child created after the survey', async () => {
    const folder = new FakeFolder('dir')
    folder.before.set('DELETE', () => {
      folder.arrive('late.txt')
    })
    await expect(removing(folder)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(folder.children).toEqual(['late.txt'])
    expect(folder.methods()).toEqual(['PROPFIND', 'DELETE', 'PROPFIND'])
  })

  it('keeps what changed in a subtree after the survey', async () => {
    const folder = new FakeFolder('dir', ['a.txt'])
    folder.before.set('DELETE', () => {
      folder.arrive('late.txt')
    })
    await expect(removing(folder, false)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(folder.children).toEqual(['a.txt', 'late.txt'])
    expect(folder.methods()).toEqual(['PROPFIND', 'DELETE'])
  })

  it('surveys again after a child came and went', async () => {
    const folder = new FakeFolder('dir')
    ageing(folder)
    folder.before.set('DELETE', () => {
      folder.arrive('tmp')
      folder.children = []
    })
    await removing(folder)
    expect(folder.exists).toBe(false)
    expect(folder.methods()).toEqual(['PROPFIND', 'DELETE', 'PROPFIND', 'PROPFIND', 'DELETE'])
  })

  it.each([0, 1000])(
    'waits out a fresh collection without rewriting it (age %i ms)',
    async (age) => {
      const folder = new FakeFolder('dir', [], age)
      const original = folder.modified
      ageing(folder)
      await removing(folder)
      expect(folder.exists).toBe(false)
      expect(folder.methods()).toEqual(['PROPFIND', 'PROPFIND', 'DELETE'])
      expect(sleep).toHaveBeenCalledOnce()
      expect(sleep).toHaveBeenCalledWith(FENCE - age)
      expect(folder.modified).toBe(original)
    },
  )

  it('keeps a write raced by two removers', async () => {
    const folder = new FakeFolder('dir', [], 0)
    ageing(folder)
    folder.before.set('DELETE', () => {
      folder.arrive('late.txt')
    })
    const outcomes = await Promise.allSettled([removing(folder), removing(folder)])
    expect(
      outcomes.map((o) => (o.status === 'rejected' ? (o.reason as { code: string }).code : null)),
    ).toEqual(['ENOTEMPTY', 'ENOTEMPTY'])
    expect(folder.children).toEqual(['late.txt'])
    expect(folder.methods().slice(0, 2)).toEqual(['PROPFIND', 'PROPFIND'])
    expect(folder.methods()).not.toContain('PROPPATCH')
  })

  it('backdates a future-dated collection', async () => {
    const folder = new FakeFolder('dir', [], -86_400_000)
    await removing(folder)
    expect(folder.exists).toBe(false)
    expect(folder.methods()).toEqual(['PROPFIND', 'PROPPATCH', 'PROPFIND', 'DELETE'])
  })

  it('puts the backdated time back when the removal fails', async () => {
    const folder = new FakeFolder('dir', [], -86_400_000)
    const original = folder.modified
    folder.before.set('PROPPATCH', () => {
      folder.locked = true
    })
    await expect(removing(folder)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(folder.exists).toBe(true)
    expect(folder.modified).toBe(original)
    expect(folder.methods().at(-1)).toBe('PROPPATCH')
  })

  it('keeps the removal error when the restore fails', async () => {
    const folder = new FakeFolder('dir', [], -86_400_000)
    folder.before.set('PROPPATCH', () => {
      folder.locked = true
    })
    folder.before.set('DELETE', () => {
      folder.before.set('PROPPATCH', () => {
        throw new TypeError('fetch failed')
      })
    })
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    await expect(removing(folder)).rejects.toMatchObject({ code: 'EBUSY' })
  })

  it('is busy when a future-dated collection cannot be backdated', async () => {
    const folder = new FakeFolder('dir', [], -86_400_000)
    folder.settable = false
    await expect(removing(folder)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(folder.methods()).toEqual(
      Array.from({ length: ATTEMPTS }, () => ['PROPFIND', 'PROPPATCH']).flat(),
    )
  })

  it.each([true, false])('is busy when the collection keeps changing (empty %s)', async (empty) => {
    const folder = new FakeFolder('dir')
    folder.busy = true
    await expect(removing(folder, empty)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(folder.exists).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(ATTEMPTS)
    expect(folder.methods()).not.toContain('DELETE')
  })

  it.each<[Partial<FakeFolder>, string]>([
    [{ exists: false }, 'ENOENT'],
    [{ locked: true }, 'EBUSY'],
  ])('maps a server refusal to an errno (%o)', async (setup, code) => {
    const folder = Object.assign(new FakeFolder('dir'), setup)
    await expect(removing(folder)).rejects.toMatchObject({ code })
  })

  it.each<Record<string, string>>([
    { getlastmodified: '' },
    { getlastmodified: 'soon' },
    { Date: 'soon' },
  ])('refuses an unreadable date with EIO before any DELETE (%o)', async (dates) => {
    const folder = new FakeFolder('dir')
    folder.dates = dates
    await expect(removing(folder)).rejects.toMatchObject({ code: 'EIO' })
    expect(folder.exists).toBe(true)
    expect(folder.methods()).toEqual(['PROPFIND'])
  })

  it.each([
    ['a b#c', `${ROOT}/a%20b%23c/`],
    ['x/a b', `${ROOT}/x/a%20b/`],
  ])('deletes an encoded or nested name at its own URL (%s)', async (name, url) => {
    const folder = new FakeFolder(name)
    await removing(folder)
    expect(folder.exists).toBe(false)
    expect(folder.calls.map((call) => call.url)).toEqual([url, url])
  })
})

describe('nextcloud rmR', () => {
  it('takes a subtree in one delete', async () => {
    const folder = new FakeFolder('dir', ['a.txt', 'sub/'])
    vi.stubGlobal('fetch', folder.fetch)
    await rmR(new NextcloudAccessor({ url: `${ROOT}/` }), PathSpec.fromStrPath('/dir'))
    expect(folder.exists).toBe(false)
    expect(folder.methods()).toEqual(['PROPFIND', 'DELETE'])
    expect(folder.calls[0]?.headers.Depth).toBe('0')
  })
})
