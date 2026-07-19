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
import { generateText, stepCountIs } from 'ai'
import { openai } from '@ai-sdk/openai'
import { mirageTools } from '@struktoai/mirage-agents/vercel'
import { buildSystemPrompt } from '@struktoai/mirage-agents/openai'

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development'),
})

const ram = new RAMResource()
const ops = new OpsRegistry()
for (const op of ram.ops()) ops.register(op)
const ws = new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })

const system = buildSystemPrompt({
  mountInfo: { '/': 'In-memory filesystem (read/write)' },
  extraInstructions:
    'All file paths start from /. Use the execute tool to run shell commands ' +
    'and the readFile/writeFile/editFile/ls tools for direct file operations.',
})

const task =
  "Create /hello.txt with the content 'Hello from Mirage!'. " +
  'Then create /data/numbers.csv with columns name,value and 3 sample rows. ' +
  'Finally, list and read /hello.txt and every file under /data. Do not inspect /dev.'

const { text, steps } = await generateText({
  model: openai('gpt-5.4-mini'),
  system,
  prompt: task,
  tools: mirageTools(ws),
  stopWhen: stepCountIs(20),
})

console.log(text)
console.log(`\n--- ${String(steps.length)} step(s) ---`)

console.log('\n--- Verifying files in workspace ---')
const findAll = await ws.execute('find / -type f')
const paths = findAll.stdoutText
  .trim()
  .split('\n')
  .filter((path) => path.length > 0 && !path.startsWith('/dev/'))
console.log(paths.join('\n'))

for (const path of paths) {
  const content = await ws.fs.readFileText(path)
  console.log(`cat ${path}:\n${content}`)
}
