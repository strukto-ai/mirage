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
  S3Resource,
  SlackResource,
  Workspace,
  type S3Config,
  type SlackConfig,
} from '@struktoai/mirage-node'
import { Agent, run } from '@openai/agents'
import { buildSystemPrompt } from '@struktoai/mirage-agents/openai'
import { configureOpenAIExample } from './config.ts'

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development'),
})

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} env var is required (set in .env.development)`)
  }
  return value
}

const s3Config: S3Config = {
  bucket: requireEnv('AWS_S3_BUCKET'),
  region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
}
const slackConfig: SlackConfig = {
  token: requireEnv('SLACK_BOT_TOKEN'),
}

const ram = new RAMResource()
const s3 = new S3Resource(s3Config)
const slack = new SlackResource(slackConfig)

const ops = new OpsRegistry()
for (const op of ram.ops()) ops.register(op)
for (const op of s3.ops()) ops.register(op)
for (const op of slack.ops()) ops.register(op)

const ws = new Workspace(
  {
    '/': ram,
    '/s3': [s3, MountMode.READ] as const,
    '/slack': [slack, MountMode.READ] as const,
  },
  {
    mode: MountMode.WRITE,
    ops,
  },
)
const openAI = configureOpenAIExample(ws, 'gpt-5.5')

const agent = new Agent({
  name: 'Mirage Multi-Resource Agent',
  model: openAI.model,
  instructions: buildSystemPrompt({ workspace: ws }),
  tools: openAI.tools,
})

const task =
  '1. Find the date of the latest Slack message in the general channel. ' +
  '2. Summarize the parquet file in /s3/data/. ' +
  'Write your findings to /report.txt.'

const result = await run(agent, task)
console.log(result.finalOutput)

const findAll = await ws.execute('find / -type f')
console.log('\n--- Files in workspace ---')
console.log(findAll.stdoutText)

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
