import { describe, expect, it } from 'vitest'
import { FileChangeKind, PathSpec, type WalkEntry } from '../types.ts'
import { ListingDeltaHook, specFor } from './delta.ts'

function walkFrom(tree: Map<string, string | null>) {
  return async function* walk(): AsyncGenerator<WalkEntry> {
    await Promise.resolve()
    for (const [virtual, fingerprint] of tree) {
      yield { virtual, isDir: fingerprint === null, fingerprint }
    }
  }
}

describe('ListingDeltaHook', () => {
  it('frames paths from roots with trailing slashes', () => {
    const root = PathSpec.fromStrPath('/nc///', '')
    expect(specFor(root, '/nc/file.txt').resourcePath).toBe('file.txt')
  })

  it('uses the first pull as a baseline', async () => {
    const hook = new ListingDeltaHook(walkFrom(new Map([['/nc/a.txt', 'e1']])))
    const delta = await hook.pull(PathSpec.fromStrPath('/nc'), null)
    expect(delta.changes).toEqual([])
    expect(delta.checkpoint).not.toBeNull()
  })

  it('detects creates, updates, and deletes', async () => {
    const tree = new Map<string, string | null>([
      ['/nc/a.txt', 'e1'],
      ['/nc/old.txt', 'old'],
    ])
    const hook = new ListingDeltaHook(walkFrom(tree))
    const baseline = await hook.pull(PathSpec.fromStrPath('/nc'), null)
    tree.set('/nc/a.txt', 'e2')
    tree.set('/nc/new.txt', 'new')
    tree.delete('/nc/old.txt')
    const delta = await hook.pull(PathSpec.fromStrPath('/nc'), baseline.checkpoint)
    expect(delta.changes.map((event) => [event.path.virtual, event.kind])).toEqual([
      ['/nc/a.txt', FileChangeKind.UPDATE],
      ['/nc/new.txt', FileChangeKind.CREATE],
      ['/nc/old.txt', FileChangeKind.DELETE],
    ])
    expect(delta.changes[0]?.metadata?.fingerprint).toBe('e2')
  })

  it('carries post-change metadata', async () => {
    const before = new ListingDeltaHook(walkFrom(new Map([['/nc/a.txt', 'e1']])))
    const baseline = await before.pull(PathSpec.fromStrPath('/nc'), null)
    const walk = async function* (): AsyncGenerator<WalkEntry> {
      await Promise.resolve()
      yield {
        virtual: '/nc/a.txt',
        isDir: false,
        fingerprint: 'e2',
        size: 2,
        modified: '2026-01-02T00:00:00Z',
      }
    }
    const delta = await new ListingDeltaHook(walk).pull(
      PathSpec.fromStrPath('/nc'),
      baseline.checkpoint,
    )
    expect(delta.changes[0]?.metadata).toMatchObject({
      fingerprint: 'e2',
      size: 2,
      modified: '2026-01-02T00:00:00Z',
    })
  })
})
