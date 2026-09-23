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

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskVFS, MountMode, PathSpec, Workspace } from '@struktoai/mirage-node'

const MOUNT = '/data'

// Lay down the files the baseline pull will record.
function seed(root: string): void {
  mkdirSync(join(root, 'reports'))
  writeFileSync(join(root, 'reports', 'q1.txt'), 'first quarter\n')
  writeFileSync(join(root, 'reports', 'q2.txt'), 'second quarter\n')
}

// Change the directory the way an outside writer would. Nothing here
// goes through the workspace: this stands in for the teammate, cron job
// or pipeline that mirage has to detect rather than be told about.
function writeBehindMirage(root: string): void {
  writeFileSync(join(root, 'reports', 'q3.txt'), 'third quarter\n')
  writeFileSync(join(root, 'reports', 'q1.txt'), 'first quarter, revised\n')
  unlinkSync(join(root, 'reports', 'q2.txt'))
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'mirage-disk-watch-'))
  seed(tmp)

  const vfs = new DiskVFS({ root: tmp })
  const ws = new Workspace({ [MOUNT]: vfs }, { mode: MountMode.READ })
  const hook = vfs.deltaHook()
  const root = PathSpec.fromStrPath(MOUNT, '')

  // A baseline pull records state and reports nothing. Hand the
  // checkpoint back on the next call and it diffs against it.
  let delta = await hook.pull(root, null)
  const checkpoint = delta.checkpoint
  console.log(`baseline: ${delta.changes.length} changes`)

  writeBehindMirage(tmp)

  delta = await hook.pull(root, checkpoint)
  console.log(`\npull: ${delta.changes.length} changes`)
  const changes = [...delta.changes].sort((a, b) => a.path.virtual.localeCompare(b.path.virtual))
  for (const change of changes) {
    console.log(`  ${change.kind.padEnd(6)} ${change.path.virtual}`)
    await ws.notify(change)
  }

  // notify invalidates the caches for the changed path and its ancestor
  // listings before delivering, so a read after an event can never serve
  // pre-change bytes.
  let result = await ws.shell(`cat ${MOUNT}/reports/q1.txt`)
  console.log(`\nread after notify: '${result.stdoutText.trim()}'`)
  result = await ws.shell(`ls ${MOUNT}/reports`)
  console.log(`listing: ${result.stdoutText.split(/\s+/).filter(Boolean).join(' ')}`)

  await ws.close()
  rmSync(tmp, { recursive: true, force: true })
}

await main()
