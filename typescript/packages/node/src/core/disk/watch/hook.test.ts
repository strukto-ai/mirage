// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { FileChangeKind, PathSpec } from '@struktoai/mirage-core/types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskAccessor } from '../../../accessor/disk.ts'
import { DiskEventHook } from './hook.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mirage-watch-disk-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function spec(virtual: string, vfsPath: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath })
}

describe('DiskEventHook', () => {
  function map(eventType: string, payload: unknown) {
    return new DiskEventHook(new DiskAccessor(root)).toEvents(
      spec('/d/data', 'data'),
      eventType,
      payload as never,
    )
  }

  it('maps a create to the virtual path', async () => {
    const events = await map('created', { src_path: path.join(root, 'data', 'a.txt') })
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe(FileChangeKind.CREATE)
    expect(events[0]?.path.virtual).toBe('/d/data/a.txt')
    expect(events[0]?.path.vfsPath).toBe('data/a.txt')
  })

  it('maps modified and deleted', async () => {
    const target = path.join(root, 'data', 'a.txt')
    expect((await map('modified', { src_path: target }))[0]?.kind).toBe(FileChangeKind.UPDATE)
    expect((await map('deleted', { src_path: target }))[0]?.kind).toBe(FileChangeKind.DELETE)
  })

  it('maps a move to both sides', async () => {
    const events = await map('moved', {
      src_path: path.join(root, 'data', 'old.txt'),
      dest_path: path.join(root, 'data', 'new.txt'),
    })
    expect(events[0]?.kind).toBe(FileChangeKind.MOVE)
    expect(events[0]?.path.virtual).toBe('/d/data/new.txt')
    expect(events[0]?.previousPath?.virtual).toBe('/d/data/old.txt')
  })

  it('reports a move out of the mount as a delete', async () => {
    const events = await map('moved', {
      src_path: path.join(root, 'data', 'old.txt'),
      dest_path: '/elsewhere/new.txt',
    })
    expect(events[0]?.kind).toBe(FileChangeKind.DELETE)
    expect(events[0]?.path.virtual).toBe('/d/data/old.txt')
  })

  it('ignores a path outside the mount', async () => {
    expect(await map('created', { src_path: '/elsewhere/a.txt' })).toEqual([])
  })

  it('ignores an unknown event type', async () => {
    expect(await map('opened', { src_path: path.join(root, 'data', 'a.txt') })).toEqual([])
  })

  it('reports a move into the mount as a create', async () => {
    const events = await map('moved', {
      src_path: '/elsewhere/old.txt',
      dest_path: path.join(root, 'data', 'new.txt'),
    })
    expect(events[0]?.kind).toBe(FileChangeKind.CREATE)
    expect(events[0]?.path.virtual).toBe('/d/data/new.txt')
    expect(events[0]?.previousPath).toBeNull()
  })

  it('ignores a move that touches neither side', async () => {
    expect(
      await map('moved', { src_path: '/elsewhere/old.txt', dest_path: '/nowhere/new.txt' }),
    ).toEqual([])
  })

  it('normalizes the mount root', async () => {
    const events = await map('modified', { src_path: root })
    expect(events[0]?.path.virtual).toBe('/d')
    expect(events[0]?.path.vfsPath).toBe('')
  })

  it('ignores a payload without a path', async () => {
    expect(await map('created', { nothing: 'here' })).toEqual([])
    expect(await map('created', 'not-an-object')).toEqual([])
  })
})
