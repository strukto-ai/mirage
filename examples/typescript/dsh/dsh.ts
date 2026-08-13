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

// DeepSeek Harness (dsh) providers over one mirage workspace: RAM,
// Redis, and Slack mounted side by side, with monty capturing python.
// dsh's file tools write into Redis, its bash tool greps across the
// mounts, and a script uploaded to a Slack channel runs with monty,
// its output filed back into Redis.
//
// Usage: SLACK_BOT_TOKEN=... [SLACK_CHANNEL=general] [REDIS_URL=...] npx tsx dsh.ts
// Upload example.py (next to this file) to the channel first.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { Context } from '@deepseek-ai/cordis'
import type { ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import {
  buildRuntime,
  MountMode,
  RAMResource,
  RedisResource,
  SlackResource,
  Workspace,
} from '@struktoai/mirage-node'
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

function bash(shell: ShellExecutor, command: string): Promise<ShellRunResult> {
  return shell.run(shell.resolve({ command }))
}

async function composeWorld(ws: Workspace): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MirageService, { workspace: ws }).await()
  await ctx.plugin(MirageFileSystem, {}).await()
  await ctx.plugin(MirageShellExecutor, {}).await()
  return ctx
}

// ctx.fs — the seam dsh's read/write/edit tools call, here writing
// into a real Redis: the write lands as a key, the stale-version guard
// applies, and every other mount edits the same way.
async function fileTools(ctx: Context): Promise<void> {
  console.log('=== ctx.fs: file tools on redis ===')
  const target = await ctx.fs.resolve('/redis/todo.txt')
  await ctx.fs.writeText(target, 'ship the adapters\n')
  const info = await ctx.fs.stat(target)
  console.log('stat:', info?.type, info?.size, 'bytes')
  const edited = await ctx.fs.editText(
    target,
    { oldString: 'ship', newString: 'shipped', replaceAll: false },
    info === undefined ? undefined : { version: info.version },
  )
  console.log('edit:', edited.after.trim())
}

// ctx.shell — the seam dsh's bash tool calls: mirage's own shell, so
// one grep sweeps Redis and RAM together and ls reads Slack.
async function bashTool(ctx: Context): Promise<void> {
  console.log('=== ctx.shell: bash tool ===')
  const shell = ctx.shell
  const grep = await bash(shell, 'grep -rn shipped /redis /tmp')
  console.log('grep:', grep.stdout.text.trim())
  const channels = await bash(shell, 'ls /slack/channels | head -3')
  console.log(channels.stdout.text.trim())
}

// The channel directory embeds the Slack ID (general__C...) and an
// upload gets its file ID suffixed the same way (example__F0....py), so
// match both on the human-name prefix; date dirs list newest-first and
// uploads land under <channel>/<date>/files/.
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

// python under monty: the Slack backend serves the source, monty
// computes in its sandbox, and the shell's redirection files the
// report into Redis for any tool to read.
async function runFromSlack(ctx: Context, channel: string): Promise<void> {
  console.log('=== python: monty on a slack-hosted script ===')
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
  const ran = await bash(shell, `MIRAGE_RUNNER=dsh-monty python3 ${script} > /redis/report.txt`)
  console.log('exit:', ran.exitCode, ran.stderr.text.trim())
  const report = await bash(shell, 'cat /redis/report.txt')
  console.log(report.stdout.text.trim())
}

async function main(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  if (token === undefined || token === '') throw new Error('SLACK_BOT_TOKEN env var is required')
  const channel = process.env.SLACK_CHANNEL ?? 'general'
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379/1'

  // EXEC admits code execution (the mode ladder is READ < WRITE < EXEC);
  // monty is set up to capture python and python3, and the catch-all vfs
  // runtime serving the shell commands is always present.
  const ws = new Workspace(
    {
      '/tmp': [new RAMResource(), MountMode.EXEC],
      '/redis': [new RedisResource({ url: redisUrl, keyPrefix: 'dsh:' }), MountMode.WRITE],
      '/slack': [new SlackResource({ token }), MountMode.EXEC],
    },
    { runtimes: [buildRuntime('monty', { captures: ['python', 'python3'] })] },
  )
  const ctx = await composeWorld(ws)
  try {
    await fileTools(ctx)
    await bashTool(ctx)
    await runFromSlack(ctx, channel)
    await bash(ctx.shell, 'rm -f /redis/todo.txt /redis/report.txt')
  } finally {
    await ws.close()
  }
}

await main()
