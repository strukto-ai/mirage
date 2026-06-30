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

import { MountMode, RedisObserverStore, RedisResource, Workspace } from '@struktoai/mirage-node'
import { assertRealMtime, runCases } from './cases.ts'

async function main(): Promise<void> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
  const runId = `${String(process.pid)}-${String(Date.now())}`
  const resource = new RedisResource({ url, keyPrefix: `mirage-integ-${runId}` })
  const observe = new RedisObserverStore({ url, keyPrefix: `mirage-integ-observer-${runId}:` })
  const ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE, observe })
  try {
    await runCases(ws)
    await assertRealMtime(ws)
    await observe.clear()
  } finally {
    await ws.close()
    await observe.close()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
