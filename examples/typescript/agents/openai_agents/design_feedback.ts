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

// The SDK's debug log is enabled from the environment:
//   DEBUG=openai-agents:* pnpm exec tsx agents/openai_agents/design_feedback.ts

import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { run } from '@openai/agents'
import { SandboxAgent } from '@openai/agents/sandbox'
import { LINEAR } from '@struktoai/mirage-core'
import {
  GitHubVFS,
  LinearVFS,
  MountMode,
  RAMVFS,
  SlackVFS,
  Workspace,
  type ExecuteOptions,
  type ExecuteResult,
  type LinearConfig,
  type SlackConfig,
} from '@struktoai/mirage-node'
import { MirageSandboxClient } from '@struktoai/mirage-agents/openai_agents'

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

const GITHUB_OWNER = process.env.MIRAGE_GITHUB_OWNER ?? 'strukto-ai'
const GITHUB_REPO = process.env.MIRAGE_GITHUB_REPO ?? 'mirage'
const GITHUB_REF = process.env.MIRAGE_GITHUB_REF ?? 'main'

const searchToken = process.env.SLACK_USER_TOKEN
const slackConfig: SlackConfig = {
  token: requireEnv('SLACK_BOT_TOKEN'),
  ...(searchToken !== undefined && searchToken !== '' ? { searchToken } : {}),
}
const linearConfig: LinearConfig = { apiKey: requireEnv('LINEAR_API_KEY') }

const slack = new SlackVFS(slackConfig)
const github = await GitHubVFS.create({
  token: requireEnv('GITHUB_TOKEN'),
  owner: GITHUB_OWNER,
  repo: GITHUB_REPO,
  ref: GITHUB_REF,
})
const linear = new LinearVFS(linearConfig)

const ws = new Workspace({
  '/': [new RAMVFS(), MountMode.WRITE],
  '/slack': [slack, MountMode.READ],
  '/github': [github, MountMode.READ],
  '/linear': [linear, MountMode.WRITE],
})
ws.registerCli('linear', LINEAR, { ...linearConfig })

const shell = ws.shell.bind(ws) as (
  command: string,
  options?: ExecuteOptions,
) => Promise<ExecuteResult>
ws.shell = (async (command: string, options?: ExecuteOptions) => {
  console.log(`[shell] ${command}`)
  const result = await shell(command, options)
  const out = result.stdoutText.slice(0, 200)
  if (out !== '') {
    console.log(`[shell] -> ${JSON.stringify(out)}`)
  }
  return result
}) as typeof ws.shell

const client = new MirageSandboxClient(ws)

const agent = new SandboxAgent({
  name: 'Mirage design feedback agent',
  model: 'gpt-5.5',
  instructions: await ws.vfsMd(),
})

const task =
  'Triage the latest user feedback about Mirage from the Slack ' +
  'incident channel: read the message and any attached screenshot, ' +
  'find the relevant code in the Mirage GitHub repo, then file a ' +
  'design issue in the Strukto-ai team on Linear using ' +
  '`linear issue create` with the feedback and code references.'

const result = await run(agent, task, { maxTurns: 30, sandbox: { client } })
console.log('\n--- agent output ---')
console.log(result.finalOutput)
await ws.close()
