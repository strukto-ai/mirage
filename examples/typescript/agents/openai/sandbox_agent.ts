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

import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { run } from '@openai/agents'
import { Capabilities, SandboxAgent } from '@openai/agents/sandbox'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'
import { MirageCapability, MirageSandboxClient } from '@struktoai/mirage-agents/openai'

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development'),
})

const data = new RAMVFS()
const seed = new Workspace({ '/': data }, { mode: MountMode.WRITE })
await seed.vfs.write('/report.csv', 'region,revenue\nnorth,120\nsouth,95\neast,143\nwest,88\n')

const ws = new Workspace(
  { '/': new RAMVFS(), '/data': [data, MountMode.READ] },
  { mode: MountMode.WRITE },
)

const agent = new SandboxAgent({
  name: 'Mirage Sandbox Agent',
  model: process.env.OPENAI_MODEL ?? 'gpt-5.5',
  capabilities: [...Capabilities.default(), new MirageCapability()],
})

const task =
  'Find the region with the highest revenue in /data/report.csv ' +
  'and write a one-line summary of it to /summary.txt.'

const result = await run(agent, task, { sandbox: { client: new MirageSandboxClient(ws) } })
console.log(result.finalOutput)

console.log('\n--- /summary.txt ---')
console.log(new TextDecoder().decode(await ws.vfs.read('/summary.txt')))
await ws.close()
