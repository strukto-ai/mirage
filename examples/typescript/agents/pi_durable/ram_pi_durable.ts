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
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'
import { MirageExecutionEnv, mirageExtension } from '@struktoai/mirage-pi-durable'

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development'),
})

const provider = process.env.PI_PROVIDER?.trim() ?? ''
const modelId = process.env.PI_MODEL?.trim() ?? ''
if (provider === '' || modelId === '') {
  throw new Error('PI_PROVIDER and PI_MODEL must be set together')
}

const context = BACKGROUND_CONTEXT
const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })

const registry = createRegistry()
registry.install(CodingTools)
registry.install(mirageExtension(ws))

const harness = await Harness.open(
  new MemoryStorage(),
  {
    models: builtinModels(),
    registry,
    env: ({ cwd }) => new MirageExecutionEnv(ws, { cwd: cwd ?? '/' }),
  },
  context,
)
const root = await harness.root(context, { agent: { model: { provider, modelId } } })

const task =
  "Create /hello.txt with 'Hello from Mirage!' and /data/numbers.csv " +
  'with columns name,value and 3 sample rows. Then list all files.'

const settled = await (await root.submit({ type: 'input', content: task }, context)).wait(context)
if (settled.status === 'done' && settled.type === 'input') {
  const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
  for (const message of answer?.model ?? []) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) if (part.type === 'text') console.log(part.text)
  }
} else {
  console.log(`unanswered: ${JSON.stringify(settled)}`)
}
await harness.close(context)

console.log('\n--- Files in workspace ---')
const found = (await ws.shell("find / -type f -not -path '/dev/*' -not -path '/usr/*'")).stdoutText
for (const path of found.trim().split('\n').filter(Boolean)) {
  console.log(`cat ${path}:\n${new TextDecoder().decode(await ws.vfs.read(path))}`)
}
