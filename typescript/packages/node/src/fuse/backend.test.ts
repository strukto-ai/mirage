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

import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { Workspace } from '../workspace.ts'
import {
  checkMountpoint,
  checkPlatform,
  checkSizes,
  FSKIT_MOUNT_ROOT,
  MountBackend,
  resolveBackend,
  unsizedMounts,
} from './backend.ts'

describe('resolveBackend', () => {
  it.each([
    [undefined, MountBackend.FUSE],
    [null, MountBackend.FUSE],
    ['', MountBackend.FUSE],
    ['fuse', MountBackend.FUSE],
    ['fskit', MountBackend.FSKIT],
    ['FSKIT', MountBackend.FSKIT],
  ])('resolves %s', (input, expected) => {
    expect(resolveBackend(input)).toBe(expected)
  })

  it('rejects an unknown backend', () => {
    expect(() => resolveBackend('auto')).toThrow(/unknown mount backend/)
  })

  it('offers no auto backend', () => {
    // Deliberate: auto-selecting fskit would silently break every API-backed
    // mount, so the only safe value is also the default.
    expect(Object.values(MountBackend)).toEqual(['fuse', 'fskit'])
  })
})

describe('checkPlatform', () => {
  it('allows fuse everywhere', () => {
    expect(() => {
      checkPlatform(MountBackend.FUSE)
    }).not.toThrow()
  })

  it('rejects fskit: fuse-native cannot reach the FSKit shim', () => {
    // Known gap mirrored from docs/typescript/setup/fuse.mdx —
    // @zkochan/fuse-native bundles a pre-macFUSE-5 dylib, so the option
    // never reaches a driver that understands it. Python is the only side
    // that can serve fskit.
    expect(() => {
      checkPlatform(MountBackend.FSKIT)
    }).toThrow(/fskit/)
  })
})

describe('checkMountpoint', () => {
  it.each([FSKIT_MOUNT_ROOT, `${FSKIT_MOUNT_ROOT}/mirage-abc`, `${FSKIT_MOUNT_ROOT}/nested/deep`])(
    'accepts %s',
    (mountpoint) => {
      expect(() => {
        checkMountpoint(MountBackend.FSKIT, mountpoint)
      }).not.toThrow()
    },
  )

  it.each(['/tmp/mirage-abc', '/Users/me/mnt', '/Volumes-not-really/x'])(
    'rejects %s',
    (mountpoint) => {
      expect(() => {
        checkMountpoint(MountBackend.FSKIT, mountpoint)
      }).toThrow(/only mounts under \/Volumes/)
    },
  )

  it('ignores the fuse backend', () => {
    // The /Volumes rule is an FSKit constraint, not a mirage one.
    expect(() => {
      checkMountpoint(MountBackend.FUSE, '/tmp/mirage-abc')
    }).not.toThrow()
  })
})

describe('unsizedMounts / checkSizes', () => {
  it('reports nothing for a byte-store workspace', () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    expect(unsizedMounts(ws)).toEqual([])
    expect(() => {
      checkSizes(MountBackend.FSKIT, ws, '')
    }).not.toThrow()
  })

  it('does not treat the always-mounted history view as size-unknown', () => {
    // /.bash_history renders from in-memory events, so it must not block a
    // root-scoped fskit mount.
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    const prefixes = unsizedMounts(ws).map(([prefix]) => prefix)
    expect(prefixes).not.toContain('/.bash_history/')
  })

  it('ignores the fuse backend entirely', () => {
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    expect(() => {
      checkSizes(MountBackend.FUSE, ws, '')
    }).not.toThrow()
  })

  it('scopes the check to the mount root prefix', () => {
    const ws = new Workspace(
      { '/ram/': new RAMResource(), '/other/': new RAMResource() },
      { mode: MountMode.WRITE },
    )
    expect(() => {
      checkSizes(MountBackend.FSKIT, ws, '/ram/')
    }).not.toThrow()
  })
})
