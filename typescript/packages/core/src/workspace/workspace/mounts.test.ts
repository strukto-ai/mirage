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

import { RAMVFS } from '../../vfs/ram/ram.ts'
import { type ReadSpec, DEFAULT_READ_TTL, Limit, MountMode, ReadPolicy } from '../../types.ts'
import { normalizeMounts } from './mounts.ts'
import { Mount } from '../mount/spec.ts'
import { MountEntry } from '../mount/mount.ts'

const DEFAULT_READ: ReadSpec = { policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL }

describe('normalizeMounts', () => {
  it('keeps a bare VFS with no pinned mode', () => {
    const vfs = new RAMVFS()
    const normalized = normalizeMounts({ '/a': vfs }, DEFAULT_READ)
    expect(normalized.bare['/a']).toBe(vfs)
    expect(normalized.modes['/a']).toBeUndefined()
    expect(normalized.commandLimits['/a']).toBeUndefined()
  })

  it('pins the mode from a pair entry', () => {
    const normalized = normalizeMounts({ '/a': [new RAMVFS(), MountMode.READ] }, DEFAULT_READ)
    expect(normalized.modes['/a']).toBe(MountMode.READ)
  })

  it('carries commandLimits from a triple entry', () => {
    const guard = new Limit({ timeoutSeconds: 1 })
    const normalized = normalizeMounts(
      {
        '/a': [new RAMVFS(), MountMode.READ, { curl: guard }],
      },
      DEFAULT_READ,
    )
    expect(normalized.commandLimits['/a']).toEqual({ curl: guard })
  })

  // The map is sparse by design -- it carries only what a Mount
  // overrode, and the registry applies `?? defaultRead` -- so the thing
  // to pin is that a mount which declared nothing is still judged
  // against the default rather than skipped.
  it('leaves the read slot empty for a bare VFS and a pair', () => {
    const fallback: ReadSpec = { policy: ReadPolicy.BOUNDED, ttl: 45 }
    const normalized = normalizeMounts(
      { '/a': new RAMVFS(), '/b': [new RAMVFS(), MountMode.READ] },
      fallback,
    )
    expect(normalized.read['/a']).toBeUndefined()
    expect(normalized.read['/b']).toBeUndefined()
  })

  // Python's ReadSpec is a frozen dataclass, so a spec cannot be edited
  // after the verdict passed it. A plain JS object can be, which would
  // let a caller flip a mount to `fresh` behind the verdict's back.
  it("freezes a copy of the caller's spec rather than storing it", () => {
    const caller: ReadSpec = { policy: ReadPolicy.BOUNDED, ttl: 30 }
    const entry = new MountEntry({ prefix: '/a/', vfs: new RAMVFS(), read: caller })
    expect(entry.read).not.toBe(caller)
    expect(Object.isFrozen(entry.read)).toBe(true)
    expect(() => {
      ;(caller as { policy: string }).policy = ReadPolicy.FRESH
    }).not.toThrow()
    expect(entry.read.policy).toBe(ReadPolicy.BOUNDED)
  })

  // Downstream -- the gate, the routing reconcile -- all compare with
  // `===`, so the spec has to be normalized where it becomes live mount
  // state or a capable backend mounts `fresh` and behaves as bounded.
  it('stores the coerced policy, not the wire string it was given', () => {
    const entry = new MountEntry({
      prefix: '/a/',
      vfs: new RAMVFS(),
      read: { policy: 'BOUNDED' as never, ttl: 30 },
    })
    expect(entry.read.policy).toBe(ReadPolicy.BOUNDED)
  })

  it('judges a mount that declared nothing against the default', () => {
    const fresh: ReadSpec = { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL }
    expect(() => normalizeMounts({ '/a': new RAMVFS() }, fresh)).toThrow(
      /needs a resource that caches reads/,
    )
    expect(() => normalizeMounts({ '/a': [new RAMVFS(), MountMode.READ] }, fresh)).toThrow(
      /needs a resource that caches reads/,
    )
  })

  it('judges a Mount against its own read, not the default', () => {
    // The override direction: a `fresh` workspace default must not
    // refuse a mount that declared `bounded` for itself.
    const fresh: ReadSpec = { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL }
    expect(() =>
      normalizeMounts(
        { '/a': new Mount(new RAMVFS(), { read: { policy: ReadPolicy.BOUNDED, ttl: 30 } }) },
        fresh,
      ),
    ).not.toThrow()
  })

  // The Mount branch is new with this PR and nothing covered it: its
  // read and its commandLimits ride the one options object, so a build
  // that filled it for one key and overwrote it for the other would drop
  // a mount's limits the moment it declared a policy.
  it("keeps a Mount's own read and commandLimits over the default", () => {
    const guard = new Limit({ timeoutSeconds: 1 })
    const vfs = new RAMVFS()
    const normalized = normalizeMounts(
      {
        '/a': new Mount(vfs, {
          mode: MountMode.READ,
          read: { policy: ReadPolicy.BOUNDED, ttl: 30 },
          commandLimits: { curl: guard },
        }),
      },
      { policy: ReadPolicy.BOUNDED, ttl: 45 },
    )
    expect(normalized.bare['/a']).toBe(vfs)
    expect(normalized.modes['/a']).toBe(MountMode.READ)
    expect(normalized.read['/a']).toEqual({ policy: ReadPolicy.BOUNDED, ttl: 30 })
    expect(normalized.commandLimits['/a']).toEqual({ curl: guard })
  })
})
