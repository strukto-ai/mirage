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
  S3Resource,
  Workspace,
  type S3Config,
} from '@struktoai/mirage-node'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { buildSystemPrompt, mirageExtension } from '@struktoai/mirage-agents/pi'
import { configurePiModel } from './config.ts'

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
const s3 = new S3Resource(s3Config)
const ops = new OpsRegistry()
for (const op of s3.ops()) ops.register(op)
const ws = new Workspace({ '/s3/': s3 }, { mode: MountMode.READ, ops })

const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  settingsManager: SettingsManager.create(process.cwd(), getAgentDir()),
  systemPrompt: buildSystemPrompt({
    mountInfo: { '/s3/': 'S3 bucket (CSV, Parquet, JSONL)' },
  }),
  extensionFactories: [mirageExtension(ws)],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
})
await resourceLoader.reload()

const modelRuntime = await ModelRuntime.create()
const model = await configurePiModel(modelRuntime)
const { session } = await createAgentSession({
  model,
  modelRuntime,
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
})

session.subscribe((event) => {
  if (
    event.type === 'message_update' &&
    event.assistantMessageEvent.type === 'text_delta'
  ) {
    process.stdout.write(event.assistantMessageEvent.delta)
  }
})

await session.prompt(
  'Explore and summarize the data in /s3/data/. Use head command for large files.',
)
console.log()

await session.prompt(
  'How many rows are in the parquet, orc, and h5 files under /s3/data/?',
)
console.log()

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
