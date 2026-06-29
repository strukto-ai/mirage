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
import { DiskObserverStore, DiskResource, MountMode, Workspace } from '@struktoai/mirage-node'
import { assertRealMtime, runCases } from './cases.ts'

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'mirage-integ-disk-'))
  const obsRoot = mkdtempSync(join(tmpdir(), 'mirage-integ-observer-'))
  const ws = new Workspace(
    { '/data': new DiskResource({ root }) },
    { mode: MountMode.WRITE, observe: new DiskObserverStore(obsRoot) },
  )
  try {
    await runCases(ws)
    await assertRealMtime(ws)
  } finally {
    await ws.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(obsRoot, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
