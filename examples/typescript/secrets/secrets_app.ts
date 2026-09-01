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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

import { MountMode, SlackResource, Workspace } from '@struktoai/mirage-node'

// The application's own environment, loaded first. It carries two
// different credentials for two different planes: the slack token the
// mount is built from here, and the 1Password service account token
// the `op` source authenticates with.
const HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(HERE, '../../../.env.development') })

const token = process.env.SLACK_BOT_TOKEN
if (token === undefined || token === '') throw new Error('SLACK_BOT_TOKEN is required')
const searchToken = process.env.SLACK_USER_TOKEN

const resource = new SlackResource({
  token,
  ...(searchToken !== undefined && searchToken !== '' ? { searchToken } : {}),
})

const LINES = [
  // The mount, built from the dotenv value above.
  'ls /slack | head -n 3',
  // The session's own variables, fetched from 1Password by the line
  // that reads them. Lengths, not values.
  'echo "bot token: ${#SLACK_BOT_TOKEN} chars"',
  'echo "user token: ${#SLACK_USER_TOKEN} chars"',
  // A session write beats the pointer and outlives the line. The
  // mount keeps the token it was built with either way.
  'export SLACK_BOT_TOKEN=overridden-in-session',
  'echo "bot token now: $SLACK_BOT_TOKEN"',
  'ls /slack | head -n 1',
]

const dec = new TextDecoder()

/** Run one line and print what the agent would see. */
async function show(ws: Workspace, line: string): Promise<void> {
  const result = await ws.execute(line)
  console.log(`$ ${line}`)
  console.log(`  exit ${result.exitCode}`)
  const out = result.stdout === null ? '' : dec.decode(result.stdout).trim()
  const err = result.stderr === null ? '' : dec.decode(result.stderr).trim()
  if (out !== '') console.log(`  out: ${out}`)
  if (err !== '') console.log(`  err: ${err}`)
  console.log()
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/slack': resource },
    {
      mode: MountMode.READ,
      // The source's own credential comes from the process env that
      // dotenv just filled.
      secrets: {
        op: {
          source: '1password',
          config: { token: { from: 'env', key: 'OP_SERVICE_ACCOUNT_TOKEN' } },
        },
      },
      env: {
        SLACK_BOT_TOKEN: { from: 'op', ref: 'op://mirage/SLACK_BOT_TOKEN', key: 'credential' },
        SLACK_USER_TOKEN: { from: 'op', ref: 'op://mirage/SLACK_USER_TOKEN', key: 'credential' },
      },
    },
  )
  for (const line of LINES) await show(ws, line)
  await ws.close()
}

await main()
