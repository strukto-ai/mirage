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
import { BaseResource, type Resource } from '../../resource/base.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { MountRegistry } from './registry.ts'
import { makeStorageKey } from './storage.ts'

class StoreResource extends BaseResource implements Resource {
  readonly kind = 'ram'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

// A resource pinned by config, the way disk/s3/redis are: two instances
// naming one target must compare equal.
class RootedResource extends BaseResource implements Resource {
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
  close(): Promise<void> {
    return Promise.resolve()
  }
}

// Implements Resource without extending BaseResource, so it has no
// storageId at all.
class BareResource implements Resource {
  readonly kind = 'bare'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

const spec = (virtual: string): PathSpec =>
  new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    resourcePath: virtual.replace(/^\/+/, ''),
  })

const keyFor = (mounts: Record<string, Resource>): ((p: PathSpec) => string) =>
  makeStorageKey(new MountRegistry(mounts, MountMode.WRITE))

describe('makeStorageKey', () => {
  it('treats one resource at two prefixes as one storage (#154)', () => {
    const shared = new StoreResource()
    const key = keyFor({ '/m1': shared, '/m2': shared })
    expect(key(spec('/m1/x.txt'))).toBe(key(spec('/m2/x.txt')))
  })

  it('keeps distinct resources distinct so a real move still works', () => {
    const key = keyFor({ '/m1': new StoreResource(), '/m2': new StoreResource() })
    expect(key(spec('/m1/x.txt'))).not.toBe(key(spec('/m2/x.txt')))
  })

  it('uses the config identity, so two instances on one root match', () => {
    const key = keyFor({ '/d1': new RootedResource('/tmp/r'), '/d2': new RootedResource('/tmp/r') })
    expect(key(spec('/d1/x.txt'))).toBe(key(spec('/d2/x.txt')))
  })

  it('keeps different roots separate', () => {
    const key = keyFor({ '/d1': new RootedResource('/tmp/a'), '/d2': new RootedResource('/tmp/b') })
    expect(key(spec('/d1/x.txt'))).not.toBe(key(spec('/d2/x.txt')))
  })

  it('keeps distinct paths in one storage distinct', () => {
    const shared = new StoreResource()
    const key = keyFor({ '/m1': shared, '/m2': shared })
    expect(key(spec('/m1/x.txt'))).not.toBe(key(spec('/m2/other.txt')))
  })

  it('preserves the ancestor boundary cp/mv test with startsWith(key + "/")', () => {
    const shared = new StoreResource()
    const key = keyFor({ '/m1': shared, '/m2': shared })
    expect(key(spec('/m2/dir/sub')).startsWith(`${key(spec('/m1/dir'))}/`)).toBe(true)
    expect(key(spec('/m2/dirty')).startsWith(`${key(spec('/m1/dir'))}/`)).toBe(false)
  })

  it('falls back to the mount prefix when a resource declares no identity', () => {
    // Two bare resources must stay distinct: without an identity the safe
    // answer is "its own storage", never a false same-file refusal.
    const key = keyFor({ '/b1': new BareResource(), '/b2': new BareResource() })
    expect(key(spec('/b1/x.txt'))).not.toBe(key(spec('/b2/x.txt')))
  })
})
