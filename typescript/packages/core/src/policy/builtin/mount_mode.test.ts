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
import { OpBoundary } from '../../ops/boundary.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountEntry } from '../../workspace/mount/mount.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { Policies } from '../policies.ts'

function entry(prefix: string, mode: MountMode): MountEntry {
  return new MountEntry({ prefix, vfs: new RAMVFS(), mode })
}

function path(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

// The dispatcher's own boundary: an owned path carries its mount's prefix
// and mode, an unowned one an empty prefix and full write.
async function admit(mount: MountEntry | null, target: PathSpec): Promise<void> {
  const boundary = new OpBoundary(
    new Policies(),
    mount?.prefix ?? '',
    mount?.mode ?? MountMode.WRITE,
  )
  await boundary.admit('symlink', target, true, { create: true })
}

describe('MountModePolicy', () => {
  it('mount mode governs namespace writes', async () => {
    await admit(entry('/data/', MountMode.WRITE), path('/data/lk'))
    await expect(admit(entry('/ro/', MountMode.READ), path('/ro/lk'))).rejects.toThrow(/read-only/)
  })

  it('an unowned path is writable without a session', async () => {
    await admit(null, path('/toplink'))
  })

  it('a session grant narrows an owned path', async () => {
    // The grant is what binds: it says what this session may do, which
    // covers the namespace plane as well as the backend one, so a grant
    // that stops a file write at /extra stops the table write too.
    const ws = new Workspace({ '/extra': [new RAMVFS(), MountMode.WRITE] })
    const owner = ws.namespace.tryMountFor('/extra/lk')
    const sess = ws.createSession('agent', { mounts: { '/extra/': 'read' } })
    await runWithSession(sess, async () => {
      await expect(admit(owner, path('/extra/lk'))).rejects.toThrow(/read-only/)
    })
    await admit(owner, path('/extra/lk'))
  })

  it('a root statement governs an unowned path', async () => {
    // "Above every mount" is governed by "/": a profile that caps the
    // root to read refuses the table write there, with no mount at /.
    const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] })
    const sess = ws.createSession('agent', { mounts: { '/': 'read' } })
    await runWithSession(sess, async () => {
      await expect(admit(null, path('/toplink'))).rejects.toMatchObject({ code: 'EROFS' })
    })
  })
})
