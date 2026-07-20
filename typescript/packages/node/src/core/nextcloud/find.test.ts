import { PathSpec } from '@struktoai/mirage-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { find } from './find.ts'
import { FakeNextcloudOperator, installFakeOperator } from './mock.ts'
import * as search from './search/index.ts'

vi.mock('./search/index.ts', { spy: true })

const searchFiles = vi.mocked(search.searchFiles)

function accessorWith(files: Record<string, string | Buffer>): NextcloudAccessor {
  const accessor = new NextcloudAccessor({
    url: 'https://cloud.example/remote.php/dav/files/user/',
  })
  installFakeOperator(accessor, new FakeNextcloudOperator(files))
  return accessor
}

describe('nextcloud find', () => {
  beforeEach(() => {
    searchFiles.mockReset()
    searchFiles.mockResolvedValue(null)
  })

  it('falls back to a scoped recursive scan', async () => {
    const accessor = accessorWith({
      'data/a.json': 'a',
      'data/sub/b.json': 'b',
      'other.txt': 'o',
    })

    await expect(find(accessor, PathSpec.fromStrPath('/data'))).resolves.toEqual([
      '/data',
      '/data/a.json',
      '/data/sub',
      '/data/sub/b.json',
    ])
  })

  it('only stats the start path at max depth zero', async () => {
    const accessor = new NextcloudAccessor({
      url: 'https://cloud.example/remote.php/dav/files/user/',
    })
    const operator = new FakeNextcloudOperator({ 'data/a.json': 'a' })
    const list = vi.spyOn(operator, 'list')
    installFakeOperator(accessor, operator)

    await expect(find(accessor, PathSpec.fromStrPath('/data'), { maxDepth: 0 })).resolves.toEqual([
      '/data',
    ])
    expect(list).not.toHaveBeenCalled()
    expect(searchFiles).not.toHaveBeenCalled()
  })

  it('uses Files Search for a supported name and type predicate', async () => {
    const accessor = accessorWith({ 'Documents/existing.txt': 'x' })
    searchFiles.mockResolvedValue([
      {
        key: '/Documents/Invoices',
        name: 'Invoices',
        kind: 'd',
        size: 0,
        modified: 100,
      },
      {
        key: '/Documents/Invoices-old',
        name: 'Invoices-old',
        kind: 'd',
        size: 0,
        modified: 100,
      },
    ])

    await expect(
      find(accessor, PathSpec.fromStrPath('/Documents'), { name: 'Invoices', type: 'd' }),
    ).resolves.toEqual(['/Documents/Invoices'])
    expect(searchFiles).toHaveBeenCalledOnce()
    expect(searchFiles.mock.calls[0]?.[2].tree).toEqual({
      op: 'and',
      kids: [
        { op: 'name', pattern: 'Invoices', icase: false },
        { op: 'type', kind: 'd' },
      ],
    })
  })

  it('rechecks exact name, depth, and mtime after Files Search', async () => {
    const accessor = accessorWith({ 'Projects/existing.txt': 'x' })
    searchFiles.mockResolvedValue([
      { key: '/Projects/a.pdf', name: 'a.pdf', kind: 'f', size: 5, modified: 200 },
      { key: '/Projects/a.PDF', name: 'a.PDF', kind: 'f', size: 5, modified: 200 },
      { key: '/Projects/old.pdf', name: 'old.pdf', kind: 'f', size: 5, modified: 50 },
      { key: '/Projects/deep/b.pdf', name: 'b.pdf', kind: 'f', size: 5, modified: 200 },
    ])

    await expect(
      find(accessor, PathSpec.fromStrPath('/Projects'), {
        name: '*.pdf',
        mtimeMin: 100,
        mtimeMax: 250,
        maxDepth: 1,
      }),
    ).resolves.toEqual(['/Projects/a.pdf'])
  })

  it('does not call Files Search for unsupported path and bracket predicates', async () => {
    const accessor = accessorWith({
      'Projects/a.pdf': 'a',
      'Projects/b.pdf': 'b',
      'Projects/deep/c.pdf': 'c',
    })

    await expect(
      find(accessor, PathSpec.fromStrPath('/Projects'), { pathPattern: '*/deep/*' }),
    ).resolves.toEqual(['/Projects/deep/c.pdf'])
    await expect(
      find(accessor, PathSpec.fromStrPath('/Projects'), { name: '[ab].pdf' }),
    ).resolves.toEqual(['/Projects/a.pdf', '/Projects/b.pdf'])
    expect(searchFiles).not.toHaveBeenCalled()
  })

  it('matches empty files through the scan fallback', async () => {
    const accessor = accessorWith({ 'empty.txt': '', 'full.txt': 'x' })
    await expect(find(accessor, PathSpec.fromStrPath('/'), { empty: true })).resolves.toEqual([
      '/empty.txt',
    ])
  })
})
