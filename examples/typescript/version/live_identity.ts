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

import { MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'

async function main(): Promise<void> {
  const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })

  await ws.fs.writeFile('/data/report.txt', 'hello world')
  console.log('=== wrote /data/report.txt ===')

  // RAM registers no live_identity op, so the facade's capability probe
  // answers null rather than throwing -- the same honest "unsupported" a
  // wired backend's missing op would give.
  const identity = await ws.fs.liveIdentity('/data/report.txt')
  console.log('live_identity:', identity === null ? 'None' : 'present')

  const [data, readIdentity] = await ws.fs.readFileWithIdentity('/data/report.txt')
  console.log('read_with_identity bytes:', new TextDecoder().decode(data))
  console.log('read_with_identity identity:', readIdentity === null ? 'None' : 'present')
}

await main()
