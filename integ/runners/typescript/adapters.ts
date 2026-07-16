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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPFSResource, Workspace as BrowserWorkspace } from '@struktoai/mirage-browser'
import { DiskResource, MountMode, RAMResource, RedisResource, Workspace } from '@struktoai/mirage-node'
import { installFakeNavigator, makeMockRoot } from '../../../typescript/packages/browser/src/test-utils.ts'
import type { ExecWorkspace, Target } from './harness.ts'

export interface Open {
  ws: ExecWorkspace
  cleanup: () => Promise<void>
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'

function runId(): string {
  return `${String(process.pid)}-${String(Date.now())}`
}

async function openRam(target: Target): Promise<Open> {
  const mounts: Record<string, RAMResource> = {}
  for (const m of target.mounts) mounts[m.path] = new RAMResource()
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openDisk(target: Target): Promise<Open> {
  const roots: string[] = []
  const mounts: Record<string, DiskResource> = {}
  for (const m of target.mounts) {
    const root = mkdtempSync(join(tmpdir(), 'mirage-integ-disk-'))
    roots.push(root)
    mounts[m.path] = new DiskResource({ root })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function openRedis(target: Target): Promise<Open> {
  const id = runId()
  const mounts: Record<string, RedisResource> = {}
  for (const m of target.mounts) {
    const safe = m.path.replace(/\/+/g, '-').replace(/^-|-$/g, '') || 'root'
    mounts[m.path] = new RedisResource({ url: REDIS_URL, keyPrefix: `mirage-integ-${id}-${safe}` })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openOpfs(target: Target): Promise<Open> {
  const restoreNav = installFakeNavigator(() => makeMockRoot())
  const mounts: Record<string, OPFSResource> = {}
  target.mounts.forEach((m, i) => {
    mounts[m.path] = i === 0 ? new OPFSResource() : new OPFSResource({ root: `xm${String(i)}` })
  })
  const ws = new BrowserWorkspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    restoreNav()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

export const ADAPTERS: Record<string, (target: Target) => Promise<Open>> = {
  ram: openRam,
  disk: openDisk,
  redis: openRedis,
  opfs: openOpfs,
}
