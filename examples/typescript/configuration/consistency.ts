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

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_READ_TTL,
  DiskVFS,
  MountMode,
  RAMVFS,
  ReadPolicy,
  Workspace,
  type BaseVFS,
  type ReadSpec,
} from '@struktoai/mirage-node'

// Demonstrate the per-mount read policy. Kept at this filename although
// the workspace-wide ConsistencyPolicy it was written for is gone; the
// policy it shows is now declared per mount.

function banner(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// A policy that cannot act says so, at mount time.
//
// `fresh` revalidates cached bytes against the backend before serving
// them. A backend that does not cache reads never reaches that gate, so
// declaring `fresh` on one would read as enabled and do nothing. That
// silent downgrade is what the refusal exists to prevent.
async function refusals(): Promise<void> {
  banner('read: fresh is refused where it cannot act')
  const fresh: ReadSpec = { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL }
  const root = await mkdtemp(join(tmpdir(), 'mirage-consistency-'))
  try {
    const backends: [string, BaseVFS][] = [
      ['ram', new RAMVFS()],
      ['disk', new DiskVFS({ root })],
    ]
    for (const [name, vfs] of backends) {
      try {
        const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, read: fresh })
        console.log(`${name}: accepted (unexpected)`)
        await ws.close()
      } catch (err) {
        console.log(`${name}: ${message(err)}`)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  banner('read: pinned names the layer it needs')
  try {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, read: { policy: ReadPolicy.PINNED, ttl: DEFAULT_READ_TTL } },
    )
    await ws.close()
  } catch (err) {
    console.log(message(err))
  }
}

// `bounded` is the default, and the bound is per mount.
async function bounds(): Promise<void> {
  banner('read: bounded, with a per-mount bound')
  const ws = new Workspace(
    { '/fast': new RAMVFS(), '/slow': new RAMVFS() },
    { mode: MountMode.WRITE, read: { policy: ReadPolicy.BOUNDED, ttl: 600 } },
  )
  try {
    const mounts = [...ws.mounts()].sort((a, b) => (a.prefix < b.prefix ? -1 : 1))
    for (const mount of mounts) {
      console.log(`${mount.prefix.padEnd(16)} ${mount.read.policy} ttl=${String(mount.read.ttl)}`)
    }
  } finally {
    await ws.close()
  }
}

async function main(): Promise<void> {
  await refusals()
  await bounds()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
