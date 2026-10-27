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
  DiskWorkspaceStateStore,
  MountMode,
  RAMVFS,
  RAMWorkspaceStateStore,
  Workspace,
} from '@struktoai/mirage-node'

const GROUPS = ['namespace', 'workspace', 'observer'] as const
const PROBES: Record<string, string> = {
  symlink: 'readlink /data/link || echo gone',
  cwd: 'pwd',
  variable: 'echo ${GREETING:-gone}',
  history: "grep -c 'first-r[u]n' /.bash_history || true",
}

function build(group: (typeof GROUPS)[number], root: string): Workspace {
  const store = new RAMWorkspaceStateStore({ [group]: new DiskWorkspaceStateStore({ root }) })
  return new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, workspaceId: 'agent', sessionId: 'main', store, ownsStore: true },
  )
}

async function place(group: (typeof GROUPS)[number]): Promise<void> {
  console.log(`\n=== store.${group} on disk ===`)
  const root = await mkdtemp(join(tmpdir(), 'mirage-stores-'))
  try {
    let ws = build(group, root)
    await ws.shell('echo first-run > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/link')
    await ws.shell('cd /data && export GREETING=hello')
    await ws.close()

    ws = build(group, root)
    for (const [name, line] of Object.entries(PROBES)) {
      const result = await ws.shell(line)
      console.log(`${name}: ${result.stdoutText.trim()}`)
    }
    await ws.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  for (const group of GROUPS) await place(group)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
