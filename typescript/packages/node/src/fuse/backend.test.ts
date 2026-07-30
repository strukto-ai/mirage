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

import { MountBackend, MountMode, RAMResource } from '@struktoai/mirage-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../workspace.ts'
import {
  checkMountpoint,
  checkPlatform,
  checkSizes,
  checkWrites,
  FSKIT_MOUNT_ROOT,
  prepareBackend,
  requireKernelBackend,
  resolveBackend,
  unsizedMounts,
  writableMounts,
} from './backend.ts'

describe('resolveBackend', () => {
  it.each([
    [undefined, MountBackend.VFS],
    [null, MountBackend.VFS],
    ['', MountBackend.VFS],
    ['vfs', MountBackend.VFS],
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
    expect(Object.values(MountBackend)).toEqual(['vfs', 'fuse', 'fskit'])
  })

  it('treats a missing value as vfs, never as a kernel mount', () => {
    // One meaning for "absent": the MountSpecOptions default, an absent YAML
    // key, and undefined here all land on vfs.
    expect(resolveBackend(undefined)).toBe(MountBackend.VFS)
  })

  it('rejects vfs as a mount target via requireKernelBackend', () => {
    expect(() => {
      requireKernelBackend(MountBackend.VFS)
    }).toThrow(/does not register a mountpoint/)
  })

  it('prepareBackend rejects vfs', () => {
    expect(() => prepareBackend('vfs')).toThrow(/does not register a mountpoint/)
  })

  it('prepareBackend runs the fskit guards, so no mount path can skip them', () => {
    setPlatform('darwin')
    // mountpoint guard
    expect(() => prepareBackend('fskit', undefined, '/tmp/x')).toThrow(/only mounts under/)
    // size guard
    const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    expect(() => prepareBackend('fskit', ws, `${FSKIT_MOUNT_ROOT}/m`)).not.toThrow()
  })
})

/** Stub process.platform for a test; afterEach below restores it. */
const REAL_PLATFORM = process.platform
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}
afterEach(() => {
  setPlatform(REAL_PLATFORM)
})

describe('checkPlatform', () => {
  it('allows fuse everywhere', () => {
    setPlatform('linux')
    expect(() => {
      checkPlatform(MountBackend.FUSE)
    }).not.toThrow()
  })

  it('rejects fskit off darwin', () => {
    setPlatform('linux')
    expect(() => {
      checkPlatform(MountBackend.FSKIT)
    }).toThrow(/macOS-only/)
  })

  it('allows fskit on darwin: fuse.node links the installed libfuse', () => {
    // fuse-native's fuse.node links /usr/local/lib/libfuse.2.dylib by
    // absolute path (its bundled libosxfuse.2.dylib is a stub with that
    // install name), so backend=fskit reaches macFUSE 5.x's own libfuse.
    // Verified with a live mount; see examples/typescript/fuse/fskit.ts.
    setPlatform('darwin')
    expect(() => {
      checkPlatform(MountBackend.FSKIT)
    }).not.toThrow()
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

  it('warns for a size-unknown mount but lets it proceed', () => {
    class UnsizedResource extends RAMResource {
      override readonly sizesAlwaysKnown: boolean = false
    }
    const ws = new Workspace({ '/api/': new UnsizedResource() }, { mode: MountMode.READ })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(() => {
        checkSizes(MountBackend.FSKIT, ws, '')
      }).not.toThrow()
      expect(warn).toHaveBeenCalledOnce()
      const message = String(warn.mock.calls[0]?.[0])
      expect(message).toContain('will read as empty')
      expect(message).toContain('/api/')
    } finally {
      warn.mockRestore()
    }
  })

  it('writableMounts lists write-capable mounts', () => {
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    const prefixes = writableMounts(ws, '').map(([prefix]) => prefix)
    expect(prefixes).toContain('/data/')
  })

  it('warns when an fskit mount accepts writes', () => {
    const ws = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      checkWrites(MountBackend.FSKIT, ws, '')
      expect(warn).toHaveBeenCalledOnce()
      const message = String(warn.mock.calls[0]?.[0])
      expect(message).toContain('zeroed pages')
      expect(message).toContain('/data/')
    } finally {
      warn.mockRestore()
    }
  })

  it('write warning stays silent for read mounts and the fuse backend', () => {
    const readOnly = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.READ })
    const writable = new Workspace({ '/data/': new RAMResource() }, { mode: MountMode.WRITE })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      checkWrites(MountBackend.FSKIT, readOnly, '')
      checkWrites(MountBackend.FUSE, writable, '')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
