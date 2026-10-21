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
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'
import { ChatAnthropic } from '@langchain/anthropic'
import { createDeepAgent } from 'deepagents'
import { LangchainWorkspace, extractText } from '@struktoai/mirage-langchain'

const __HERE = dirname(fileURLToPath(import.meta.url))
loadEnv({ path: resolve(__HERE, '../../../../.env.development') })

const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
const backend = new LangchainWorkspace(ws)
await backend.uploadFiles([
  ['/example.pdf', await readFile(resolve(__HERE, '../../../../data/example.pdf'))],
])

const agent = createDeepAgent({
  model: new ChatAnthropic({ model: 'claude-sonnet-4-6' }),
  backend,
})

const task =
  "Read /example.pdf and explain the paper's purpose and main idea " +
  'in two concise sentences.'
const result = await agent.invoke({
  messages: [{ role: 'user', content: task }],
})

for (const text of extractText(result.messages.slice(-1))) {
  console.log(text)
}

const pdfReadCount = ws.records.filter(
  (record) => record.op === 'read' && record.path === '/example.pdf',
).length
console.log(`\nPDF reads through Mirage: ${String(pdfReadCount)}`)
