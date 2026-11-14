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
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parsePatch } from '@deepseek-ai/dsh-fs-patch'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { DiskVFS, Workspace } from '@struktoai/mirage-node'
import { MirageFileSystem } from './fs.ts'
import type { MirageFsConfig } from './fs.ts'
import { MirageService } from './service.ts'
import { MirageShellExecutor } from './shell.ts'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import { MirageSpillStore } from './spill-store.ts'
import type { ShellExecSpec, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** A foreground run, as dsh's own tools await one: the execution's result. */
async function runOn(shell: ShellExecutor, spec: ShellExecSpec): Promise<ShellRunResult> {
  return (await shell.execute(spec)).result()
}

type SessionId = SaveTextSpill['owner']['sessionId']
type ToolCallId = Extract<SaveTextSpill['source'], { kind: 'tool' }>['callId']

const workspaces: Workspace[] = []

async function makeWorld(): Promise<Context> {
  const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] })
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
    const result = await runOn(
      shell,
      shell.resolve({ command: `cat ${ctx.fs.processPath(target)}` }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('written by the fs seam\n')
  })

  it('a file created by the shell stats and edits through ctx.fs', async () => {
    const ctx = await makeWorld()
    const shell = ctx.shell
    const written = await runOn(
      shell,
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
    const reread = await runOn(shell, shell.resolve({ command: 'cat /data/made.txt' }))
    expect(reread.stdout.text).toBe('from the mirage shell')
  })

  it('mirage coreutils see fs-seam writes: grep across a tree', async () => {
    const ctx = await makeWorld()
    await ctx.fs.writeText(await ctx.fs.resolve('/data/one.txt'), 'alpha needle\n')
    await ctx.fs.writeText(await ctx.fs.resolve('/data/two.txt'), 'no match here\n')
    const shell = ctx.shell
    const result = await runOn(shell, shell.resolve({ command: 'grep -rl needle /data' }))
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
    const grepped = await runOn(shell, shell.resolve({ command: `grep needle ${locator}` }))
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

type DirectoryAgent = Parameters<WorkingDirectoryService['ensure']>[0]

/**
 * A world composed with dsh's own Session store, projections, system
 * prompt and working-directory service over the mirage seams: the
 * services every bash, file and search tool asks for a directory.
 *
 * @param launched the directory dsh recorded for the Session, none when null.
 * @param ws the workspace, two RAM mounts when omitted.
 * @param fs the mirage filesystem's config.
 * @returns the context and an Agent owning one Session.
 */
async function directoryWorld(
  launched: string | null,
  ws: Workspace = new Workspace({
    '/data': [new RAMVFS(), MountMode.WRITE],
    '/notes': [new RAMVFS(), MountMode.WRITE],
  }),
  fs: MirageFsConfig = {},
): Promise<{ ctx: Context; ws: Workspace; agent: DirectoryAgent }> {
  workspaces.push(ws)
  const ctx = new Context()
  await ctx.plugin(SessionStore).await()
  await ctx.plugin(SessionProjectionRegistry).await()
  await ctx.plugin(SystemPrompt, {}).await()
  await ctx.plugin(MirageService, { workspace: ws }).await()
  await ctx.plugin(MirageFileSystem, fs).await()
  await ctx.plugin(MirageShellExecutor, {}).await()
  await ctx.plugin(WorkingDirectoryService, {}).await()
  const session = ctx.sessions.create(
    undefined,
    launched === null ? {} : { meta: { cwd: launched } },
  )
  const agent = {
    session,
    ctx: { fiber: { assertActive: () => undefined } },
    inject: () => undefined,
  } as unknown as DirectoryAgent
  return { ctx, ws, agent }
}

describe("dsh's working directory", () => {
  it('starts a host-launched Session in the world', async () => {
    const { ctx, agent } = await directoryWorld('/Users/somebody/host-project')
    expect(await ctx.workingDirectory.ensure(agent)).toBe('/')
    expect(ctx.workingDirectory.get(agent.session)).toBe('/')
  })

  it("starts in the filesystem's cwd when it has one", async () => {
    const { ctx, agent } = await directoryWorld('/Users/somebody/host-project', undefined, {
      cwd: '/data',
    })
    expect(await ctx.workingDirectory.ensure(agent)).toBe('/data')
  })

  it('places a Session that records no directory', async () => {
    const { ctx, agent } = await directoryWorld(null)
    expect(await ctx.workingDirectory.ensure(agent)).toBe('/')
  })

  it('keeps a launch directory the world already has', async () => {
    const { ctx, agent } = await directoryWorld('/notes')
    expect(await ctx.workingDirectory.ensure(agent)).toBe('/notes')
  })

  it('starts in the disk mount that holds the launch directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirage-dsh-launch-'))
    try {
      await mkdir(join(root, 'src'))
      const ws = new Workspace({ '/project': [new DiskVFS({ root }), MountMode.WRITE] })
      const { ctx, agent } = await directoryWorld(join(root, 'src'), ws)
      expect(await ctx.workingDirectory.ensure(agent)).toBe('/project/src')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('moves between mounts, and a bash call runs where it points', async () => {
    const { ctx, agent } = await directoryWorld('/Users/somebody/host-project')
    expect(await ctx.workingDirectory.set(agent, '/data')).toBe('/data')
    expect(await ctx.workingDirectory.set(agent, '../notes')).toBe('/notes')
    const workdir = await ctx.workingDirectory.ensure(agent)
    const result = await runOn(ctx.shell, ctx.shell.resolve({ command: 'pwd', workdir }))
    expect(result.stdout.text).toBe('/notes\n')
  })

  it('refuses a directory the world does not have', async () => {
    const { ctx, agent } = await directoryWorld('/Users/somebody/host-project')
    await expect(ctx.workingDirectory.set(agent, '/missing')).rejects.toMatchObject({
      code: 'WORKING_DIRECTORY_NOT_FOUND',
    })
    expect(ctx.workingDirectory.get(agent.session)).toBe('/')
  })

  it('recovers when the directory is removed under it', async () => {
    const { ctx, ws, agent } = await directoryWorld('/Users/somebody/host-project')
    await ws.vfs.mkdir('/data/sub')
    await ctx.workingDirectory.set(agent, '/data/sub')
    await runOn(ctx.shell, ctx.shell.resolve({ command: 'rmdir /data/sub' }))
    expect(await ctx.workingDirectory.ensure(agent)).toBe('/')
  })
})

describe('apply_patch operations over mounts', () => {
  it('updates, moves across mounts and deletes from one parsed patch', async () => {
    const { ctx, ws } = await directoryWorld('/')
    await ws.vfs.write('/data/a.txt', 'one\ntwo\n')
    await ws.vfs.write('/data/b.txt', 'keep\nold\n')
    await ws.vfs.write('/data/c.txt', 'gone\n')
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: /data/b.txt',
        '@@',
        ' keep',
        '-old',
        '+new',
        '*** Update File: /data/a.txt',
        '*** Move to: /notes/a.txt',
        '@@',
        ' one',
        '-two',
        '+three',
        '*** Delete File: /data/c.txt',
        '*** End Patch',
      ].join('\n'),
    )
    for (const op of operations) {
      const target = await ctx.fs.resolve(op.path)
      if (op.kind === 'delete') await ctx.fs.deleteFile(target)
      else if (op.kind === 'update' && op.moveTo !== undefined) {
        const moved = await ctx.fs.moveFile(target, await ctx.fs.resolve(op.moveTo), {
          hunks: op.hunks,
        })
        expect(moved.sourceDeleted).toBe(true)
      } else if (op.kind === 'update') await ctx.fs.patchText(target, op.hunks)
    }
    const shown = await runOn(
      ctx.shell,
      ctx.shell.resolve({ command: 'cat /data/b.txt /notes/a.txt; ls /data' }),
    )
    expect(shown.stdout.text).toBe('keep\nnew\none\nthree\nb.txt\n')
  })
})
