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

import { describe, expect, it } from 'vitest'
import { BaseVFS } from '../../vfs/base.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { MountRegistry } from './registry.ts'
import { makeStorageKey, vfsStorageId } from './storage.ts'

class StoreVFS extends BaseVFS {
  readonly kind = 'ram'
  open(): Promise<void> {
    return Promise.resolve()
  }
}

// A VFS pinned by config, the way disk/s3/redis are: two instances
// naming one target must compare equal.
class RootedVFS extends BaseVFS {
  readonly kind = 'disk'
  constructor(readonly root: string) {
    super()
  }
  override storageId(): string {
    return `${this.kind}:${this.root}`
  }
  open(): Promise<void> {
    return Promise.resolve()
  }
}

const spec = (virtual: string): PathSpec =>
  new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    vfsPath: virtual.replace(/^\/+/, ''),
  })

const keyFor = (mounts: Record<string, BaseVFS>): ((p: PathSpec) => string) =>
  makeStorageKey(new MountRegistry(mounts, MountMode.WRITE))

describe('makeStorageKey', () => {
  it('treats one VFS at two prefixes as one storage (#154)', () => {
    const shared = new StoreVFS()
    const key = keyFor({ '/m1': shared, '/m2': shared })
    expect(key(spec('/m1/x.txt'))).toBe(key(spec('/m2/x.txt')))
  })

  it('keeps distinct mounts distinct so a real move still works', () => {
    const key = keyFor({ '/m1': new StoreVFS(), '/m2': new StoreVFS() })
    expect(key(spec('/m1/x.txt'))).not.toBe(key(spec('/m2/x.txt')))
  })

  it('uses the config identity, so two instances on one root match', () => {
    const key = keyFor({ '/d1': new RootedVFS('/tmp/r'), '/d2': new RootedVFS('/tmp/r') })
    expect(key(spec('/d1/x.txt'))).toBe(key(spec('/d2/x.txt')))
  })

  it('keeps different roots separate', () => {
    const key = keyFor({ '/d1': new RootedVFS('/tmp/a'), '/d2': new RootedVFS('/tmp/b') })
    expect(key(spec('/d1/x.txt'))).not.toBe(key(spec('/d2/x.txt')))
  })

  it('keeps distinct paths in one storage distinct', () => {
    const shared = new StoreVFS()
    const key = keyFor({ '/m1': shared, '/m2': shared })
    expect(key(spec('/m1/x.txt'))).not.toBe(key(spec('/m2/other.txt')))
  })

  it('preserves the ancestor boundary cp/mv test with startsWith(key + "/")', () => {
    const shared = new StoreVFS()
    const key = keyFor({ '/m1': shared, '/m2': shared })
    expect(key(spec('/m2/dir/sub')).startsWith(`${key(spec('/m1/dir'))}/`)).toBe(true)
    expect(key(spec('/m2/dirty')).startsWith(`${key(spec('/m1/dir'))}/`)).toBe(false)
  })

  it('resolves nested backings onto one key', () => {
    // /a rooted at /srv/data and /b at /srv/data/sub make /a/sub/x and
    // /b/x one file; separate key components kept them apart.
    const key = keyFor({
      '/a': new RootedVFS('/srv/data'),
      '/b': new RootedVFS('/srv/data/sub'),
    })
    expect(key(spec('/a/sub/x.txt'))).toBe(key(spec('/b/x.txt')))
  })

  it('does not fuse roots that merely share a name prefix', () => {
    const key = keyFor({
      '/a': new RootedVFS('/srv/data'),
      '/b': new RootedVFS('/srv/dataX'),
    })
    expect(key(spec('/a/y.txt'))).not.toBe(key(spec('/b/y.txt')))
  })

  it('vfsStorageId is stable per object', () => {
    const store = new StoreVFS()
    expect(vfsStorageId(store)).toBe(vfsStorageId(store))
    expect(vfsStorageId(store)).not.toBe(vfsStorageId(new StoreVFS()))
  })
})
