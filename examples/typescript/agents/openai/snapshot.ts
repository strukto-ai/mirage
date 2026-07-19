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
import {
  MountMode,
  OpsRegistry,
  RAMResource,
  Workspace,
  toStateDict,
} from '@struktoai/mirage-node'
import { Agent, run } from '@openai/agents'
import { buildSystemPrompt } from '@struktoai/mirage-agents/openai'
import { configureOpenAIExample } from './config.ts'

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development'),
})

function makeWorkspace(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

const ws = makeWorkspace()
const openAI = configureOpenAIExample(ws, 'gpt-5.5-mini')

const agent = new Agent({
  name: 'Snapshot Demo',
  model: openAI.model,
  instructions: buildSystemPrompt({
    workspace: ws,
    extraInstructions:
      'Write a 3-line note about Mirage to /report.txt using the shell or execute tool.',
  }),
  tools: openAI.tools,
})

const result = await run(agent, 'Create the report.')
console.log('Agent output:', result.finalOutput)

const findOrig = await ws.execute('find / -type f')
const origFiles = findOrig.stdoutText.trim().split('\n').filter(Boolean)

console.log('\n--- Original files ---')
console.log(origFiles.join('\n'))

console.log('\n--- Persisting snapshot ---')
const state = await toStateDict(ws)
console.log(`snapshot mounts: ${state.mounts.length}`)

console.log('\n--- Restoring into fresh workspace ---')
const fresh = await Workspace.fromState(state)
const findFresh = await fresh.execute('find / -type f')
const freshFiles = findFresh.stdoutText.trim().split('\n').filter(Boolean)
console.log(freshFiles.join('\n'))

console.log('\n--- Per-file content match ---')
let matched = 0
let differ = 0
for (const path of origFiles) {
  const a = await ws.fs.readFileText(path)
  const b = await fresh.fs.readFileText(path)
  if (a === b) {
    console.log(`  ✓ ${path}  (${a.length} chars match)`)
    matched += 1
  } else {
    console.log(`  ✗ ${path}`)
    differ += 1
  }
}
console.log(`\n--- content summary: ${matched} match, ${differ} differ ---`)

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
