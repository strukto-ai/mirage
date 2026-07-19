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
import { MountMode, OpsRegistry, RAMResource, Workspace } from '@struktoai/mirage-node'
import { ChatAnthropic } from '@langchain/anthropic'
import { createDeepAgent } from 'deepagents'
import {
  LangchainWorkspace,
  buildSystemPrompt,
  extractText,
} from '@struktoai/mirage-agents/langchain'

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development'),
})

const ram = new RAMResource()
const ops = new OpsRegistry()
for (const op of ram.ops()) ops.register(op)
const ws = new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })

const agent = createDeepAgent({
  model: new ChatAnthropic({ model: 'claude-sonnet-4-6' }),
  systemPrompt: buildSystemPrompt({
    mountInfo: { '/': 'In-memory filesystem (read/write)' },
  }),
  backend: new LangchainWorkspace(ws),
})

const task =
  "Create /hello.txt with 'Hello from Mirage!' and /data/numbers.csv " +
  'with columns name,value and 3 sample rows. Then list all files.'

const result = await agent.invoke({
  messages: [{ role: 'user', content: task }],
})

for (const text of extractText(result.messages.slice(-1))) {
  console.log(text)
}

console.log('\n--- Files in workspace ---')
const findAll = await ws.execute('find / -type f')
const findOut = findAll.stdoutText
console.log(findOut)

for (const path of findOut.trim().split('\n').filter(Boolean)) {
  const content = await ws.fs.readFileText(path)
  console.log(`cat ${path}:\n${content}`)
}

const records = ws.records
if (records.length > 0) {
  const total = records.reduce((sum, r) => sum + r.bytes, 0)
  console.log(`\n--- ${records.length} ops, ${total.toLocaleString()} bytes ---`)
  for (const r of records) {
    console.log(
      `  ${r.op.padEnd(8)} ${r.source.padEnd(8)} ` +
        `${String(r.bytes).padStart(10)} B ` +
        `${String(r.durationMs).padStart(5)} ms  ${r.path}`,
    )
  }
}
