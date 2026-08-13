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

// DeepSeek Harness (dsh) providers over a mirage workspace: the same
// Cordis plugins a dsh profile would compose, exercised directly.
//
// The whole world here is in-memory — a complete, hermetic sandbox for
// dsh's file tools, bash tool, and python, gone when the workspace
// closes. Swap the RAM mounts for S3, Gmail, Slack, Notion, Postgres,
// ... and nothing below changes.

import { Context } from '@deepseek-ai/cordis'
import type { ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { buildRuntime, MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'
import { MirageFileSystem, MirageService, MirageShellExecutor } from '@struktoai/mirage-dsh'

// Monty is sandboxed compute with no host access: the shell's
// redirection files its stdout back into the mount, and env is the way
// in (the TypeScript binding bridges os.getenv, not builtin open()).
const REPORT_SCRIPT = `import os

who = os.getenv("REPORT_OWNER", "nobody")
fib = [1, 1]
while len(fib) < 10:
    fib.append(fib[-1] + fib[-2])
print("owner:", who)
print("fib10:", fib[-1])
`

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

// ctx.fs — the seam dsh's read/write/edit tools call. resolve() turns a
// path into the stable FsTarget every other operation takes: aliases
// and symlinks collapse to one identity, so a stale-write guard cannot
// be dodged by re-spelling the path.
async function fileTools(ctx: Context): Promise<void> {
  console.log('=== ctx.fs: file tools ===')
  const target = await ctx.fs.resolve('/notes/todo.txt')
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
// coreutils, pipes, and the policy layer apply to the same files. The
// fs seam's processPath is a live path here: one execution world.
async function bashTool(ctx: Context): Promise<void> {
  console.log('=== ctx.shell: bash tool ===')
  const shell = ctx.shell
  const listing = await bash(shell, 'ls -l /notes /docs')
  console.log(listing.stdout.text)
  const grep = await bash(shell, 'grep -rn shipped /notes | head -1')
  console.log('grep:', grep.stdout.text.trim())
  const target = await ctx.fs.resolve('/notes/todo.txt')
  const wc = await bash(shell, `wc -c ${ctx.fs.processPath(target)}`)
  console.log('wc:', wc.stdout.text.trim())
}

// python3 under monty: the fs seam writes the script, monty computes,
// the shell files the report back into the mount for any tool to read.
async function pythonUnderMonty(ctx: Context): Promise<void> {
  console.log('=== python3: monty ===')
  await ctx.fs.writeText(await ctx.fs.resolve('/notes/report.py'), REPORT_SCRIPT)
  const shell = ctx.shell
  const ran = await bash(shell, 'REPORT_OWNER=mirage python3 /notes/report.py > /notes/report.txt')
  console.log('exit:', ran.exitCode)
  const report = await bash(shell, 'cat /notes/report.txt')
  console.log(report.stdout.text.trim())
}

async function main(): Promise<void> {
  // EXEC admits code execution (the mode ladder is READ < WRITE < EXEC);
  // monty is set up to capture python and python3, so those lines run on
  // the sandboxed interpreter instead of the default pyodide.
  const ws = new Workspace(
    {
      '/notes': [new RAMResource(), MountMode.EXEC],
      '/docs': [new RAMResource(), MountMode.WRITE],
    },
    {
      mode: MountMode.EXEC,
      runtimes: [buildRuntime('monty', { captures: ['python', 'python3'] }), 'vfs'],
    },
  )
  await ws.fs.writeFile('/docs/readme.md', '# demo\nmirage inside dsh\n')

  const ctx = await composeWorld(ws)
  try {
    await fileTools(ctx)
    await bashTool(ctx)
    await pythonUnderMonty(ctx)
  } finally {
    await ws.close()
  }
}

await main()
