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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { DEFAULT_READ_TTL, MountMode, ReadPolicy } from '@struktoai/mirage-core/types'
import { DiskVFS } from '../vfs/disk/disk.ts'
import { Workspace } from '../workspace.ts'

const DEC = new TextDecoder()

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('fingerprint spike (port of test_fingerprint_spike.py)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mirage-fp-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  // Disk is answered by the first rule, not the token-quality one: it
  // does not cache reads, so there is no gate to revalidate at.
  it('disk cannot declare fresh', () => {
    writeFileSync(join(root, 'file.txt'), 'v1')
    expect(
      () =>
        new Workspace(
          { '/data': new DiskVFS({ root }) },
          { mode: MountMode.WRITE, read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL } },
        ),
    ).toThrow(/needs a resource that caches reads/)
  })

  it('disk under bounded reads current bytes, because it caches none', async () => {
    writeFileSync(join(root, 'file.txt'), 'v1')
    const vfs = new DiskVFS({ root })
    const ws = new Workspace(
      { '/data': vfs },
      { mode: MountMode.WRITE, read: { policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL } },
    )

    const io1 = await ws.shell('cat /data/file.txt')
    const first = DEC.decode(io1.stdout)
    await sleep(1100)
    writeFileSync(join(root, 'file.txt'), 'v2')
    const io2 = await ws.shell('cat /data/file.txt')
    const second = DEC.decode(io2.stdout)

    expect(first).toBe('v1')
    // Disk does not cache reads at all, so `bounded` has nothing to serve
    // stale. The old assertion allowed either byte string, which no
    // implementation could fail.
    expect(second).toBe('v2')
    await ws.close()
  })

  // This used to assert the opposite: that a RAM mount under `fresh` "falls
  // back gracefully" when no fingerprint is present. That fallback is the
  // bug the read policy exists to remove -- a mount that asked to
  // revalidate and quietly did not.
  it('ram cannot declare fresh', () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/file.txt', new TextEncoder().encode('v1'))
    expect(
      () =>
        new Workspace(
          { '/data': vfs },
          { mode: MountMode.WRITE, read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL } },
        ),
    ).toThrow(/needs a resource that caches reads/)
  })
})
