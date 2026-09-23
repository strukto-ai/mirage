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
import { runWithSession } from '../../context/session_context.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { MountEntry } from '../mount/mount.ts'
import { Workspace } from '../workspace/workspace.ts'
import { BARE_PREFIX, requireTurfWritable, turfOf } from './lineage.ts'

function entry(prefix: string, mode: MountMode): MountEntry {
  return new MountEntry({ prefix, vfs: new RAMVFS(), mode })
}

function path(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('turfOf', () => {
  it('an owned path is its mounts prefix', () => {
    // The prefix, because that is the key a profile writes a per-mount
    // mode under; the mount's own mode is not part of the rule.
    expect(turfOf(entry('/data/', MountMode.READ))).toBe('/data/')
  })

  it('an unowned path is the root', () => {
    expect(turfOf(null)).toBe(BARE_PREFIX)
    expect(BARE_PREFIX).toBe('/')
  })
})

describe('requireTurfWritable', () => {
  it('a read mount still takes a link', () => {
    // A read-only MOUNT is a statement about a backend that cannot
    // write, and a symlink is namespace state that needs no write
    // capability from it -- which is why a link is pinned working above
    // postgres, mongodb, chroma and qdrant, all mounted read. Only a
    // session grant binds this plane.
    requireTurfWritable(entry('/data/', MountMode.WRITE), path('/data/lk'))
    requireTurfWritable(entry('/ro/', MountMode.READ), path('/ro/lk'))
  })

  it('bare turf is writable without a session', () => {
    requireTurfWritable(null, path('/toplink'))
  })

  it('a session grant narrows an owned turf', async () => {
    // The grant is what binds: it says what this session may do, which
    // covers the namespace plane as well as the backend one, so a grant
    // that stops a file write at /extra stops the table write too.
    const ws = new Workspace({ '/extra': [new RAMVFS(), MountMode.WRITE] })
    const owner = ws.namespace.tryMountFor('/extra/lk')
    const sess = ws.createSession('agent', { mounts: { '/extra/': 'read' } })
    await runWithSession(sess, () => {
      expect(() => {
        requireTurfWritable(owner, path('/extra/lk'))
      }).toThrow(/read-only/)
      return Promise.resolve()
    })
    requireTurfWritable(owner, path('/extra/lk'))
  })

  it('a root statement governs bare turf', async () => {
    // "Above every mount" is governed by "/": a profile that caps the
    // root to read refuses the table write there, with no mount at /.
    const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] })
    const sess = ws.createSession('agent', { mounts: { '/': 'read' } })
    await runWithSession(sess, () => {
      let thrown: unknown = null
      try {
        requireTurfWritable(null, path('/toplink'))
      } catch (err) {
        thrown = err
      }
      expect(thrown).toMatchObject({ code: 'EROFS' })
      return Promise.resolve()
    })
  })
})
