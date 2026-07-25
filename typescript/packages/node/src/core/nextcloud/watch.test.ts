import { FileChangeKind, PathSpec } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { FakeNextcloudOperator, installFakeOperator } from './mock.ts'
import { buildDeltaHook } from './watch.ts'

describe('Nextcloud delta hook', () => {
  it('detects changes from a recursive WebDAV listing', async () => {
    const accessor = new NextcloudAccessor({ url: 'https://cloud.example.test' })
    const operator = new FakeNextcloudOperator({ 'Documents/a.txt': 'a' })
    installFakeOperator(accessor, operator)
    const hook = buildDeltaHook(accessor)
    const root = PathSpec.fromStrPath('/nc/Documents', 'Documents')
    const baseline = await hook.pull(root, null)
    operator.files.set('Documents/a.txt', Buffer.from('updated'))
    operator.files.set('Documents/b.txt', Buffer.from('b'))
    const delta = await hook.pull(root, baseline.checkpoint)
    expect(delta.changes.map((event) => [event.path.virtual, event.kind])).toEqual([
      ['/nc/Documents/a.txt', FileChangeKind.UPDATE],
      ['/nc/Documents/b.txt', FileChangeKind.CREATE],
    ])
    expect(delta.changes[0]?.metadata?.fingerprint).toBe('etag-7')
  })
})
