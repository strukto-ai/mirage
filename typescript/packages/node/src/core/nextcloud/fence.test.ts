import { PathSpec } from '@struktoai/mirage-core/types'
import { sleep } from '@struktoai/mirage-core/utils/abort'
import type * as Abort from '@struktoai/mirage-core/utils/abort'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { FakeFolder, ROOT } from '../../../tests/core/nextcloud/mock.ts'
import { ATTEMPTS, FENCE, remove } from './fence.ts'

vi.mock('@struktoai/mirage-core/utils/abort', async (importOriginal) => ({
  ...(await importOriginal<typeof Abort>()),
  sleep: vi.fn(() => Promise.resolve()),
}))

async function removing(folder: FakeFolder, empty = true): Promise<void> {
  vi.stubGlobal('fetch', folder.fetch)
  await remove(
    new NextcloudAccessor({ url: `${ROOT}/` }),
    PathSpec.fromStrPath(`/${folder.name}`),
    empty,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(sleep).mockClear()
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

  it.each([true, false])('is busy when the collection keeps changing (empty %s)', async (empty) => {
    const folder = new FakeFolder('dir')
    folder.settable = false
    folder.busy = true
    await expect(removing(folder, empty)).rejects.toMatchObject({ code: 'EBUSY' })
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
