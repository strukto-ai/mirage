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
import { appendDirectIO } from './mount.ts'

function fakeFuse(serialize?: () => string) {
  const nop = (cb: (err: Error | null) => void): void => {
    cb(null)
  }
  return {
    mount: nop,
    unmount: nop,
    ...(serialize !== undefined ? { _fuseOptions: serialize } : {}),
  }
}

describe('appendDirectIO', () => {
  it('appends direct_io to a non-empty option string', () => {
    const fuse = fakeFuse(() => '-oforce,attr_timeout=0')
    appendDirectIO(fuse)
    expect(fuse._fuseOptions?.()).toBe('-oforce,attr_timeout=0,direct_io')
  })

  it('emits -odirect_io when no other option serializes', () => {
    const fuse = fakeFuse(() => '')
    appendDirectIO(fuse)
    expect(fuse._fuseOptions?.()).toBe('-odirect_io')
  })

  it('does not double-append when direct_io is already present', () => {
    const fuse = fakeFuse(() => '-odirect_io,attr_timeout=0')
    appendDirectIO(fuse)
    expect(fuse._fuseOptions?.()).toBe('-odirect_io,attr_timeout=0')
  })

  it('throws when the serializer hook is gone (fork version drift)', () => {
    const fuse = fakeFuse()
    expect(() => {
      appendDirectIO(fuse)
    }).toThrow('_fuseOptions')
  })
})
