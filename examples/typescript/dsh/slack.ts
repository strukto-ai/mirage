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

// Run a Python script that lives in Slack. Upload example.py (next to
// this file) to a channel, and the dsh shell provider executes it with monty
// straight off the mount: the Slack backend serves the source, monty
// computes in its sandbox, and the shell files the output into RAM.
//
// Usage: SLACK_BOT_TOKEN=... [SLACK_CHANNEL=general] npx tsx slack.ts

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { Context } from '@deepseek-ai/cordis'
import { MountMode, RAMResource, SlackResource, Workspace } from '@struktoai/mirage-node'
import { MirageFileSystem, MirageService, MirageShellExecutor } from '@struktoai/mirage-dsh'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

const SCRIPT_NAME = 'example.py'
const SCRIPT_STEM = SCRIPT_NAME.slice(0, SCRIPT_NAME.lastIndexOf('.'))
const SCRIPT_EXT = SCRIPT_NAME.slice(SCRIPT_NAME.lastIndexOf('.'))
const RECENT_DAYS = 5

function newestFirst(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0
}

async function composeWorld(ws: Workspace): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MirageService, { workspace: ws }).await()
  await ctx.plugin(MirageFileSystem, {}).await()
  await ctx.plugin(MirageShellExecutor, {}).await()
  return ctx
}

// The channel directory embeds the Slack ID (general__C...) and an upload
// gets its file ID suffixed the same way (example__F0....py), so match both
// on the human-name prefix; uploads land under <channel>/<date>/files/.
async function findScript(ctx: Context, channel: string): Promise<string | null> {
  const channels = await ctx.fs.listDir(await ctx.fs.resolve('/slack/channels'))
  const dir = channels.find((entry) => entry.name.startsWith(`${channel}__`))
  if (dir === undefined) return null
  const days = (await ctx.fs.listDir(dir.target)).sort((a, b) => newestFirst(a.name, b.name))
  for (const day of days.slice(0, RECENT_DAYS)) {
    const filesDir = await ctx.fs.resolve(`${ctx.fs.processPath(day.target)}/files`)
    const uploads = await ctx.fs.listDir(filesDir)
    const hit = uploads.find(
      (entry) =>
        entry.name === SCRIPT_NAME ||
        (entry.name.startsWith(`${SCRIPT_STEM}__`) && entry.name.endsWith(SCRIPT_EXT)),
    )
    if (hit !== undefined) return ctx.fs.processPath(hit.target)
  }
  return null
}

async function main(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  if (token === undefined || token === '') throw new Error('SLACK_BOT_TOKEN env var is required')
  const channel = process.env.SLACK_CHANNEL ?? 'general'

  const ws = new Workspace(
    {
      '/slack': [new SlackResource({ token }), MountMode.EXEC],
      '/notes': [new RAMResource(), MountMode.WRITE],
    },
    { mode: MountMode.EXEC, runtimes: ['monty', 'vfs'] },
  )
  const ctx = await composeWorld(ws)
  try {
    const script = await findScript(ctx, channel)
    if (script === null) {
      console.log(
        `no ${SCRIPT_NAME} found in #${channel} (last ${String(RECENT_DAYS)} days); ` +
          `upload examples/typescript/dsh/${SCRIPT_NAME} to the channel and re-run`,
      )
      return
    }
    console.log('running:', script)
    const shell = ctx.shell
    const ran = await shell.run(
      shell.resolve({
        command: `MIRAGE_RUNNER=dsh-monty python3 ${script} > /notes/report.txt`,
      }),
    )
    console.log('exit:', ran.exitCode, ran.stderr.text.trim())
    const report = await shell.run(shell.resolve({ command: 'cat /notes/report.txt' }))
    console.log(report.stdout.text.trim())
  } finally {
    await ws.close()
  }
}

await main()
