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
import { DEFAULT_READ_SPEC, DEFAULT_READ_TTL, ReadPolicy, type ReadSpec } from '../../types.ts'
import type { VFS } from '../../vfs/base.ts'
import { checkReadCapability, resolveReadSpec } from './read_policy.ts'

const FRESH: ReadSpec = { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL }

// The verdict reads exactly three fields off the VFS, so a stub carrying
// them is the whole surface under test; a real backend would only add
// construction cost. The alias-inheritance sweep, which cannot live in core
// because both S3VFS classes are in the runtime packages, is in
// node/src/vfs/read_revalidatable.test.ts.
function stub(kind: string, cachesReads: boolean, readRevalidatable: boolean): VFS {
  return { kind, cachesReads, readRevalidatable } as unknown as VFS
}

describe('resolveReadSpec', () => {
  it('reads an absent policy as bounded at the default bound', () => {
    expect(resolveReadSpec(undefined, undefined)).toEqual({
      policy: ReadPolicy.BOUNDED,
      ttl: DEFAULT_READ_TTL,
    })
  })

  it('reads an empty policy as absent', () => {
    expect(resolveReadSpec('', undefined).policy).toBe(ReadPolicy.BOUNDED)
  })

  it('accepts a policy name in any case', () => {
    expect(resolveReadSpec('FRESH', undefined).policy).toBe(ReadPolicy.FRESH)
  })

  it('keeps a declared bound', () => {
    expect(resolveReadSpec('bounded', 30).ttl).toBe(30)
  })

  it('names the known policies when refusing an unknown one', () => {
    expect(() => resolveReadSpec('banana', undefined)).toThrow(/fresh, bounded, pinned/)
  })

  it('reads a null policy as absent, the way a bare YAML `read:` parses', () => {
    // Reading it as a string would die on .toLowerCase() rather than
    // answering with this door's own refusal.
    expect(resolveReadSpec(null, undefined)).toEqual(DEFAULT_READ_SPEC)
  })

  it('refuses a policy that is not a name at all', () => {
    expect(() => resolveReadSpec(123, undefined)).toThrow(/expected a policy name/)
  })

  // A non-positive bound is not a very short one: the store marks such an
  // entry expired the moment it is written (redis EXPIRE <= 0 deletes the
  // key), so the mount silently caches nothing. A non-integer is a bound
  // the store cannot compare against. Python pins the same table.
  it.each([0, -1, -600])('refuses a bound of %s', (bad) => {
    expect(() => resolveReadSpec('bounded', bad)).toThrow(/at least 1 second/)
  })

  it.each([1.5, true, '600'])('refuses a bound of %o as not whole seconds', (junk) => {
    expect(() => resolveReadSpec('bounded', junk)).toThrow(/whole seconds/)
  })
})

describe('DEFAULT_READ_SPEC', () => {
  it('is bounded at the default bound, and frozen', () => {
    expect(DEFAULT_READ_SPEC).toEqual({ policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL })
    expect(Object.isFrozen(DEFAULT_READ_SPEC)).toBe(true)
  })
})

describe('checkReadCapability', () => {
  // The programmatic door bypasses resolveReadSpec entirely: a ReadSpec
  // handed straight to `Workspace` or `addMount` never passes through
  // the coercer, so before this the mount was accepted and then kept
  // nothing -- RAM marks a ttl=0 entry expired as it is written and
  // redis deletes the key. Checked ahead of the policy dispatch,
  // because `bounded` returns from it first.
  it.each([
    [0, /at least 1 second/],
    [-1, /at least 1 second/],
    [1.5, /whole seconds/],
  ])('refuses a bound of %s that no mount could use', (bad, message) => {
    expect(() => {
      checkReadCapability('/d/', stub('ram', false, false), {
        policy: ReadPolicy.BOUNDED,
        ttl: bad,
      })
    }).toThrow(message)
  })

  // `ReadPolicy` is a string-const object, so a runtime spec carrying
  // 'FRESH' or 'banana' matched no `===` and the verdict silently
  // no-opped on the one door that skips resolveReadSpec. Worse on a
  // capable backend: it mounted and then read as `bounded` everywhere.
  it.each(['FRESH', 'banana', 'PINNED'])('judges the wire string %s like a member', (policy) => {
    expect(() => {
      checkReadCapability('/d/', stub('ram', false, false), {
        policy: policy as never,
        ttl: 30,
      })
    }).toThrow()
  })

  it('names the policy before the bound', () => {
    // The coercer's order, applied at the mount door too. Python judged
    // the bound first here, so one `ReadSpec(policy='banana', ttl=0)`
    // came back naming the bound there and the policy here, and an
    // embedder fixing what it was told was wrong hit the other next.
    expect(() => {
      checkReadCapability('/d/', stub('ram', false, false), {
        policy: 'banana' as never,
        ttl: 0,
      })
    }).toThrow(/unknown read policy/)
  })

  it('refuses pinned, naming the missing layer', () => {
    expect(() => {
      checkReadCapability('/d/', stub('ram', false, false), {
        policy: ReadPolicy.PINNED,
        ttl: DEFAULT_READ_TTL,
      })
    }).toThrow(/needs a version layer to pin to/)
  })

  it('refuses fresh on a backend that cannot cache reads', () => {
    expect(() => {
      checkReadCapability('/d/', stub('ram', false, false), FRESH)
    }).toThrow(/needs a resource that caches reads; ram does not/)
  })

  it('refuses fresh on a backend that caches but stamps nothing comparable', () => {
    expect(() => {
      checkReadCapability('/r/', stub('ssh', true, false), FRESH)
    }).toThrow(/comparable content token on reads; ssh does not/)
  })

  it('allows fresh on a backend that revalidates', () => {
    expect(() => {
      checkReadCapability('/s3/', stub('s3', true, true), FRESH)
    }).not.toThrow()
  })

  it('allows bounded on a backend that cannot revalidate', () => {
    expect(() => {
      checkReadCapability('/d/', stub('ram', false, false), {
        policy: ReadPolicy.BOUNDED,
        ttl: DEFAULT_READ_TTL,
      })
    }).not.toThrow()
  })
})
