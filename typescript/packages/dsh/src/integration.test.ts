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

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MountMode, RAMResource } from '@struktoai/mirage-core'
import { Workspace } from '@struktoai/mirage-node'
import { MirageFileSystem } from './fs.ts'
import { MirageService } from './service.ts'
import { MirageShellExecutor } from './shell.ts'

const workspaces: Workspace[] = []

async function makeWorld(): Promise<Context> {
  const ws = new Workspace({ '/data': [new RAMResource(), MountMode.WRITE] })
  workspaces.push(ws)
  const ctx = new Context()
  await ctx.plugin(MirageService, { workspace: ws }).await()
  await ctx.plugin(MirageFileSystem, {}).await()
  await ctx.plugin(MirageShellExecutor, {}).await()
  return ctx
}

afterEach(async () => {
  while (workspaces.length > 0) await workspaces.pop()?.close()
})

// The E2B-POC property the two providers exist to preserve: ctx.fs and
// ctx.shell share one execution world, so a processPath from the
// filesystem seam names the same file inside the shell.
describe('one execution world', () => {
  it('a file written through ctx.fs is readable by a ctx.shell command', async () => {
    const ctx = await makeWorld()
    const target = await ctx.fs.resolve('/data/notes.txt')
    await ctx.fs.writeText(target, 'written by the fs seam\n')
    const shell = ctx.shell
    const result = await shell.run(shell.resolve({ command: `cat ${ctx.fs.processPath(target)}` }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('written by the fs seam\n')
  })

  it('a file created by the shell stats and edits through ctx.fs', async () => {
    const ctx = await makeWorld()
    const shell = ctx.shell
    const written = await shell.run(
      shell.resolve({ command: 'printf "from the shell" > /data/made.txt' }),
    )
    expect(written.exitCode).toBe(0)
    const target = await ctx.fs.resolve('/data/made.txt')
    const info = await ctx.fs.stat(target)
    expect(info?.type).toBe('file')
    const edited = await ctx.fs.editText(
      target,
      { oldString: 'shell', newString: 'mirage shell', replaceAll: false },
      info === undefined ? undefined : { version: info.version },
    )
    expect(edited.after).toBe('from the mirage shell')
    const reread = await shell.run(shell.resolve({ command: 'cat /data/made.txt' }))
    expect(reread.stdout.text).toBe('from the mirage shell')
  })

  it('mirage coreutils see fs-seam writes: grep across a tree', async () => {
    const ctx = await makeWorld()
    await ctx.fs.writeText(await ctx.fs.resolve('/data/one.txt'), 'alpha needle\n')
    await ctx.fs.writeText(await ctx.fs.resolve('/data/two.txt'), 'no match here\n')
    const shell = ctx.shell
    const result = await shell.run(shell.resolve({ command: 'grep -rl needle /data' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text.trim()).toBe('/data/one.txt')
  })
})
