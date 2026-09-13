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
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { MirageFileSystem } from './fs.ts'
import { MirageService } from './service.ts'
import { MirageShellExecutor } from './shell.ts'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import { MirageSpillStore } from './spill-store.ts'

type SessionId = SaveTextSpill['owner']['sessionId']
type ToolCallId = Extract<SaveTextSpill['source'], { kind: 'tool' }>['callId']

const workspaces: Workspace[] = []

async function makeWorld(): Promise<Context> {
  const ws = new Workspace({ '/data': [new RAMResource(), MountMode.WRITE] })
  workspaces.push(ws)
  const ctx = new Context()
  await ctx.plugin(MirageService, { workspace: ws }).await()
  await ctx.plugin(MirageFileSystem, {}).await()
  await ctx.plugin(MirageShellExecutor, {}).await()
  await ctx.plugin(MirageSpillStore, { dir: '/data/spill' }).await()
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

// The spill loop: an oversized tool result is written by ctx.spillStore and
// recovered by the model through ctx.shell. A spill written outside this
// world hands the model a locator its next command cannot open, which is
// what a host-filesystem spill store does here.
describe('a spilled result is recoverable from inside the world', () => {
  it('grep finds a line in the artifact the spill store just wrote', async () => {
    const ctx = await makeWorld()
    const ref = await ctx.spillStore.saveText({
      owner: { sessionId: 'session-a' as SessionId },
      source: {
        kind: 'tool',
        toolName: 'bash',
        callId: 'call-1' as ToolCallId,
        label: 'result',
      },
      suggestedName: 'bash.txt',
      content: 'alpha\nbeta needle\ngamma\n',
    })
    const locator = String(ref.locator)
    const shell = ctx.shell
    // Exactly what the retrieval hint tells the model to do.
    const grepped = await shell.run(shell.resolve({ command: `grep needle ${locator}` }))
    expect(grepped.exitCode).toBe(0)
    expect(grepped.stdout.text.trim()).toBe('beta needle')
  })

  it('the fs seam reads the same artifact, byte count and all', async () => {
    const ctx = await makeWorld()
    const content = 'x'.repeat(5000)
    const ref = await ctx.spillStore.saveText({
      owner: { sessionId: 'session-a' as SessionId },
      source: {
        kind: 'session-reference',
        sessionId: 'session-b' as SessionId,
        label: 'referenced',
      },
      suggestedName: 'reference.txt',
      content,
    })
    const target = await ctx.fs.resolve(String(ref.locator))
    const info = await ctx.fs.stat(target)
    expect(info?.size).toBe(ref.bytes)
    // And the window reader the hint names: read with offset/limit.
    const window = await ctx.fs.readByteRange(target, { offset: 4990, length: 100 })
    expect(window.byteLength).toBe(10)
  })
})
