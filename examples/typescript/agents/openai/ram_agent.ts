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
import { Agent, run } from '@openai/agents'
import { buildSystemPrompt } from '@struktoai/mirage-agents/openai'
import { configureOpenAIExample } from './config.ts'

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development'),
})

const ram = new RAMResource()
const ops = new OpsRegistry()
for (const op of ram.ops()) ops.register(op)
const ws = new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
const openAI = configureOpenAIExample(ws, 'gpt-5.5-mini')

const instructions = buildSystemPrompt({
  mountInfo: { '/': 'In-memory filesystem (read/write)' },
  extraInstructions:
    'All file paths start from /. ' +
    'For example: /hello.txt, /data/numbers.csv. ' +
    'Use read_file to read text, images, and PDFs. ' +
    'Use the shell or execute tool to run commands like: ' +
    "echo 'content' > /hello.txt, mkdir /data, " +
    'cat /hello.txt, ls /.',
})

const agent = new Agent({
  name: 'Mirage RAM Agent',
  model: openAI.model,
  instructions,
  tools: openAI.tools,
})

const task =
  "Create a file /hello.txt with the content 'Hello from Mirage!'. " +
  'Then create a directory /data and write a CSV file /data/numbers.csv ' +
  'with columns: name, value. Add 3 rows of sample data. ' +
  'Finally, list all files and read the CSV with read_file.'

const result = await run(agent, task)
console.log(result.finalOutput)

console.log('\n--- Verifying files in workspace ---')
const findAll = await ws.execute("find / -type f | grep -v '^/dev/'")
const findOut = findAll.stdoutText
console.log(`workspace files:\n${findOut}`)

for (const path of findOut.trim().split('\n').filter(Boolean)) {
  const content = await ws.fs.readFileText(path)
  console.log(`cat ${path}:\n${content}`)
}

const records = ws.records
if (records.length > 0) {
  const total = records.reduce((sum, r) => sum + r.bytes, 0)
  console.log(`--- ${records.length} ops, ${total.toLocaleString()} bytes ---`)
  for (const r of records) {
    console.log(
      `  ${r.op.padEnd(8)} ${r.source.padEnd(8)} ` +
        `${String(r.bytes).padStart(10)} B ` +
        `${String(r.durationMs).padStart(5)} ms  ${r.path}`,
    )
  }
}
