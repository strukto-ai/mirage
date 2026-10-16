import { describe, expect, it } from 'vitest'
import { FileChangeKind, PathSpec } from '../types.ts'
import { changesUnder, folderPath, movedBelow, settle, specFor } from './delta.ts'

describe('specFor', () => {
  it('frames paths from roots with trailing slashes', () => {
    const root = PathSpec.fromStrPath('/nc///', '')
    expect(specFor(root, '/nc/file.txt').vfsPath).toBe('file.txt')
  })
})

// Twin of test_settle_names_each_move_by_where_the_item_was.
describe('settle', () => {
  it('names each move by where the item was', () => {
    const changes: [FileChangeKind, string][] = []
    const seen: Record<string, string> = {
      dir: '/m/old',
      f: '/m/old/f.txt',
      g: '/m/g.txt',
    }
    settle(changes, seen, 'new', '/m/new.txt', true)
    settle(changes, seen, 'edited', '/m/e.txt', false)
    settle(changes, seen, 'g', '/m/g.txt', false)
    const was = settle(changes, seen, 'dir', '/m/renamed', false)
    expect(was).not.toBeNull()
    movedBelow(seen, new Map([[was ?? '', '/m/renamed']]), new Set(['new', 'edited', 'g', 'dir']))
    settle(changes, seen, 'unseen', null, false)
    expect(changes).toEqual([
      [FileChangeKind.CREATE, '/m/new.txt'],
      [FileChangeKind.UPDATE, '/m/e.txt'],
      [FileChangeKind.UPDATE, '/m/g.txt'],
      [FileChangeKind.DELETE, '/m/old'],
      [FileChangeKind.CREATE, '/m/renamed'],
    ])
    expect(seen.f).toBe('/m/renamed/f.txt')
  })
})

// Twin of test_one_reads_folder_moves_apply_at_once: A renamed to Z and B
// renamed to A in one read: what A held goes to Z, what B held to A, and a
// path the read placed itself stays put.
describe('movedBelow', () => {
  it("applies one read's folder moves at once", () => {
    const seen: Record<string, string> = {
      x: '/m/A/x.txt',
      y: '/m/B/y.txt',
      z: '/m/B/sub/z.txt',
      c: '/m/A/c.txt',
      gone: '/m/G/g.txt',
    }
    movedBelow(
      seen,
      new Map<string, string | null>([
        ['/m/A', '/m/Z'],
        ['/m/B', '/m/A'],
        ['/m/G', null],
      ]),
      new Set(['c']),
    )
    expect(seen).toEqual({
      x: '/m/Z/x.txt',
      y: '/m/A/y.txt',
      z: '/m/A/sub/z.txt',
      c: '/m/A/c.txt',
    })
  })
})

// Twin of test_folder_path_climbs_to_the_top_and_keeps_what_it_looked_up.
describe('folderPath', () => {
  it('climbs to the top and keeps what it looked up', async () => {
    const fetched: Record<string, [string, string]> = { b: ['B', 'a'], x: ['X', ''] }
    const lookUp = (id: string): Promise<[string, string] | null> =>
      Promise.resolve(fetched[id] ?? null)
    const folders: Record<string, [string, string]> = { a: ['A', 'top'] }
    expect(await folderPath('b', 'top', folders, lookUp)).toBe('A/B')
    expect(await folderPath('top', 'top', folders, lookUp)).toBe('')
    expect(await folderPath('x', 'top', folders, lookUp)).toBeNull()
    expect(await folderPath('gone', 'top', folders, lookUp)).toBeNull()
    expect(folders).toEqual({ a: ['A', 'top'], b: ['B', 'a'], x: ['X', ''] })
  })
})

// Twin of test_changes_under_a_root_name_it_when_a_parent_moves: a change below
// the root is itself; one at a parent is the root's: the parent removed removes
// it, anything else may have moved it.
describe('changesUnder', () => {
  it('names the root when a parent moves', () => {
    const root = PathSpec.fromStrPath('/m/a/b/f.txt', 'a/b/f.txt')
    const events = changesUnder(
      root,
      [
        [FileChangeKind.UPDATE, '/m/a/b/f.txt'],
        [FileChangeKind.UPDATE, '/m/a/c.txt'],
        [FileChangeKind.DELETE, '/m/a/b'],
        [FileChangeKind.CREATE, '/m/a'],
      ],
      new Date(0),
    )
    expect(events.map((e) => [e.kind, e.path.virtual, e.path.vfsPath])).toEqual([
      [FileChangeKind.UPDATE, '/m/a/b/f.txt', 'a/b/f.txt'],
      [FileChangeKind.DELETE, '/m/a/b/f.txt', 'a/b/f.txt'],
      [FileChangeKind.UNKNOWN, '/m/a/b/f.txt', 'a/b/f.txt'],
    ])
  })
})
