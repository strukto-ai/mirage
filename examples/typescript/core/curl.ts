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

import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'

async function main(): Promise<void> {
  const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })

  console.log('=== curl (returns the raw page body) ===')
  let result = await ws.shell('curl https://example.com')
  console.log(result.stdoutText)

  console.log('\n=== curl a documentation page ===')
  result = await ws.shell('curl https://docs.python.org/3/library/json.html')
  console.log(result.stdoutText)

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
