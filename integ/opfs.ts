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

import { MountMode, OPFSResource, Workspace } from '@struktoai/mirage-browser'
import { installFakeNavigator, makeMockRoot } from '../typescript/packages/browser/src/test-utils.ts'
import { runCases } from './cases.ts'

async function main(): Promise<void> {
  const restoreNav = installFakeNavigator(() => makeMockRoot())
  const ws = new Workspace(
    { '/data': new OPFSResource(), '/data2': new OPFSResource({ root: 'xm2' }) },
    { mode: MountMode.WRITE },
  )
  try {
    await runCases(ws as unknown as Parameters<typeof runCases>[0])
  } finally {
    await ws.close()
    restoreNav()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
