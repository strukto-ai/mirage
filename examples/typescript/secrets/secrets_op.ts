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

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Workspace, configToWorkspaceArgs, loadWorkspaceConfigFile } from '@struktoai/mirage-node'

// The same workspace.yaml the python example loads: the sources and
// the variables are declared once, and both hosts only run lines.
const CONFIG = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../python/secrets/workspace.yaml',
)

// What the declared instance reads for its own credential. The dotenv
// path in the yaml is cwd-relative, so run this from the repo root the
// way every other example is run.
const DOTENV = '.env.development'
const NEEDS = ['OP_SERVICE_ACCOUNT_TOKEN']

// Every line here is ordinary bash: a managed variable is spelled
// `$SLACK_BOT_TOKEN`, never as a pointer, so nothing on the line tells
// the model a secret is involved. What each line prints is a length or
// a prefix, never a whole value -- the point is to show the real
// secret arrived, not to put it on a terminal.
const LINES = [
  // A literal needs no source and no fetch.
  'echo "environment: $MIRAGE_ENV"',
  // A line naming no secret fetches nothing at all.
  "echo 'this line reads no secret' > /data/note.txt; cat /data/note.txt",
  // An item reference read through `key: credential`. A slack bot
  // token starts `xoxb-`, so the prefix is proof the value is real.
  'printf %s "$SLACK_BOT_TOKEN" | cut -c1-5',
  'echo "bot token: ${#SLACK_BOT_TOKEN} chars"',
  // A field reference, the shape 1Password copies out of the app.
  'echo "user token: ${#SLACK_USER_TOKEN} chars"',
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
  if (!existsSync(DOTENV)) {
    console.log(
      `no ${DOTENV} at the cwd. Every line below will fail on the source's own ` +
        'config rather than on the line, which is what resolving the `secrets:` ' +
        'block once, before the first line, buys: a deployment error is not a ' +
        `per-command one.\nTo see it work, run from the repo root with ${DOTENV} ` +
        `holding ${NEEDS.join(', ')}.\n`,
    )
  }
  const { resources, options } = await configToWorkspaceArgs(loadWorkspaceConfigFile(CONFIG))
  const ws = new Workspace(resources, options)
  for (const line of LINES) await show(ws, line)
  await ws.close()
}

await main()
