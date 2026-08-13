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
// Cordis plugins a dsh profile would compose, exercised directly. The
// mirage service owns one workspace; the fs and shell providers register
// as ctx.fs and ctx.shell, dsh's seams for file tools and the bash tool,
// and share that workspace as one execution world. Swap the RAM mounts
// for S3, Slack, Notion, Postgres, ... and nothing below changes.

import { Context } from '@deepseek-ai/cordis'
import { MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'
import { MirageFileSystem, MirageService, MirageShellExecutor } from '@struktoai/mirage-dsh'

async function main(): Promise<void> {
  const ws = new Workspace({
    '/notes': [new RAMResource(), MountMode.WRITE],
    '/docs': [new RAMResource(), MountMode.WRITE],
  })
  await ws.fs.writeFile('/docs/readme.md', '# demo\nmirage inside dsh\n')

  const ctx = new Context()
  await ctx.plugin(MirageService, { workspace: ws }).await()
  await ctx.plugin(MirageFileSystem, {}).await()
  await ctx.plugin(MirageShellExecutor, {}).await()

  // ctx.fs — what dsh's read/write/edit tools call.
  const target = await ctx.fs.resolve('/notes/todo.txt')
  await ctx.fs.writeText(target, 'ship the adapters\n')
  const info = await ctx.fs.stat(target)
  console.log('stat:', info?.type, info?.size, 'bytes')
  const edited = await ctx.fs.editText(
    target,
    { oldString: 'ship', newString: 'shipped', replaceAll: false },
    info === undefined ? undefined : { version: info.version },
  )
  console.log('edited:', edited.after.trim())

  // ctx.shell — what dsh's bash tool calls: mirage's own shell, so
  // coreutils, pipes and the policy layer all apply to the same files.
  const shell = ctx.shell
  const listing = await shell.run(shell.resolve({ command: 'ls -l /notes /docs' }))
  console.log(listing.stdout.text)
  const grep = await shell.run(
    shell.resolve({ command: 'grep -rn shipped /notes | head -1' }),
  )
  console.log('grep:', grep.stdout.text.trim())

  // One execution world: the fs seam's processPath is a real path for
  // the shell.
  const viaShell = await shell.run(
    shell.resolve({ command: `wc -c ${ctx.fs.processPath(target)}` }),
  )
  console.log('wc:', viaShell.stdout.text.trim())

  await ws.close()
}

await main()
