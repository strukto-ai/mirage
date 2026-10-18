import { ContentType, FileStat, FileType, PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it, vi } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { FakeNextcloudOperator, installFakeOperator } from '../../../tests/core/nextcloud/mock.ts'
import type { SearchEntry } from './search/index.ts'
import { stat, tree } from './stat.ts'

const searched = vi.hoisted(() => ({ rows: null as SearchEntry[] | null }))
vi.mock('./search/index.ts', () => ({ searchFiles: () => Promise.resolve(searched.rows) }))

describe('nextcloud stat', () => {
  it('asks the server once for a directory and once for a missing path', async () => {
    const fake = new FakeNextcloudOperator({ 'data/file.txt': 'x' })
    const asked: string[] = []
    const realStat = fake.stat.bind(fake)
    fake.stat = (key) => {
      asked.push(key)
      return realStat(key)
    }
    const accessor = new NextcloudAccessor({
      url: 'https://cloud.example/remote.php/dav/files/user/',
    })
    installFakeOperator(accessor, fake)
    const directory = await stat(accessor, PathSpec.fromStrPath('/data'))
    expect(directory.type).toBe(FileType.DIRECTORY)
    await expect(stat(accessor, PathSpec.fromStrPath('/missing.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(asked).toEqual(['data', 'missing.txt'])
  })
})

describe('nextcloud tree', () => {
  const accessor = (): NextcloudAccessor =>
    new NextcloudAccessor({ url: 'https://cloud.example/remote.php/dav/files/user/' })

  // Mirrors test_tree_renders_each_row_as_a_listed_stat.
  it('renders each row as a listed stat', async () => {
    const when = '2026-07-11T12:00:00Z'
    searched.rows = [
      { key: '/docs/a.txt', kind: 'f', size: 3, modified: when },
      { key: '/docs/sub', kind: 'd', size: null, modified: when },
      { key: '/docs/sub/b.txt', kind: 'f', size: 0, modified: null },
      { key: '/other.txt', kind: 'f', size: 1, modified: when },
    ]
    const found = await tree(accessor(), PathSpec.fromStrPath('/docs'))
    expect(found).toEqual(
      new Map([
        [
          'a.txt',
          new FileStat({
            name: 'a.txt',
            size: 3,
            modified: when,
            type: FileType.FILE,
            content: ContentType.TEXT,
          }),
        ],
        ['sub', new FileStat({ name: 'sub', type: FileType.DIRECTORY, modified: when })],
        [
          'sub/b.txt',
          new FileStat({ name: 'b.txt', size: 0, type: FileType.FILE, content: ContentType.TEXT }),
        ],
      ]),
    )
  })

  // Mirrors test_tree_leaves_no_search_or_a_sizeless_file_to_the_walk.
  it.each<[string, SearchEntry[] | null]>([
    ['no search', null],
    ['a sizeless file', [{ key: '/docs/a.txt', kind: 'f', size: null, modified: null }]],
  ])('leaves %s to the walk', async (_label, rows) => {
    searched.rows = rows
    expect(await tree(accessor(), PathSpec.fromStrPath('/docs'))).toBeNull()
  })
})
