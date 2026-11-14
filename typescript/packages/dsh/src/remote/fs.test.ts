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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { FsVersion } from '@deepseek-ai/dsh-fs'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import { AuthMode, buildApp } from '@struktoai/mirage-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MirageFileSystem } from '../fs.ts'
import { MirageSpillStore } from '../spill-store.ts'
import { MirageClient, type MirageRemote } from './client.ts'
import { RemoteMirageService } from './service.ts'

const RAM = { config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } }
const TOKEN = 'dsh-remote-fs'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const DEC = new TextDecoder()
const ENC = new TextEncoder()

type SessionId = SaveTextSpill['owner']['sessionId']
type ToolCallId = Extract<SaveTextSpill['source'], { kind: 'tool' }>['callId']

let root: string
let app: ReturnType<typeof buildApp>
let url: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-remote-fs-'))
  app = buildApp({
    stateRoot: join(root, 'state'),
    authConfig: { mode: AuthMode.Local, localToken: TOKEN },
  })
  url = await app.listen({ port: 0, host: '127.0.0.1' })
})

afterAll(async () => {
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

async function remoteWorld(
  seed: Record<string, string> = {},
): Promise<{ ctx: Context; fs: MirageFileSystem; client: MirageClient }> {
  const made = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    payload: RAM,
    headers: AUTH,
  })
  const remote: MirageRemote = { url, workspace: made.json<{ id: string }>().id, token: TOKEN }
  const client = new MirageClient(remote)
  await client.mkdir('/data')
  for (const [path, content] of Object.entries(seed))
    await client.write(`/data/${path}`, ENC.encode(content))
  const ctx = new Context()
  await ctx.plugin(RemoteMirageService, { remote }).await()
  await ctx.plugin(MirageFileSystem, {}).await()
  return { ctx, fs: ctx.fs as MirageFileSystem, client }
}

async function versionAt(fs: MirageFileSystem, path: string): Promise<FsVersion> {
  const info = await fs.stat(await fs.resolve(path))
  if (info === undefined) throw new Error(`no ${path}`)
  return info.version
}

async function errorCode(work: Promise<unknown>): Promise<string> {
  const err = await work.then(
    () => null,
    (e: unknown) => e,
  )
  return (err as { code?: string } | null)?.code ?? 'no error'
}

describe('MirageFileSystem on a remote workspace', () => {
  it('reads, stats and lists through the server', async () => {
    const { fs } = await remoteWorld({ 'a.txt': 'one\ntwo\n', 'b.txt': 'b' })
    const target = await fs.resolve('a.txt', { cwd: '/data' })
    expect(String(target.targetKey)).toBe('/data/a.txt')
    expect(await fs.readText(target)).toBe('one\ntwo\n')
    expect(DEC.decode(await fs.readByteRange(target, { offset: 4, length: 3 }))).toBe('two')
    expect((await fs.stat(target))?.type).toBe('file')
    expect(await fs.stat(await fs.resolve('/data/nope'))).toBeUndefined()
    const names = (await fs.listDir(await fs.resolve('/data'))).map((e) => `${e.name}:${e.type}`)
    expect(names).toEqual(['a.txt:file', 'b.txt:file'])
    expect(await errorCode(fs.listDir(await fs.resolve('/data/a.txt')))).toBe('FS_NOT_DIRECTORY')
    expect(await errorCode(fs.readText(await fs.resolve('/data/nope')))).toBe('FS_NOT_FOUND')
  })

  it('writes, edits, moves and deletes through the server', async () => {
    const { fs, client } = await remoteWorld({ 'a.txt': 'alpha\nbeta\n' })
    const created = await fs.writeText(await fs.resolve('/data/new.txt'), 'first')
    expect(created.operation).toBe('create')
    const updated = await fs.writeText(await fs.resolve('/data/new.txt'), 'second')
    expect(updated.before).toBe('first')
    expect(DEC.decode(await client.read('/data/new.txt'))).toBe('second')

    const edited = await fs.editText(await fs.resolve('/data/a.txt'), {
      oldString: 'beta',
      newString: 'delta',
      replaceAll: false,
    })
    expect(edited.after).toBe('alpha\ndelta\n')

    const moved = await fs.moveFile(
      await fs.resolve('/data/a.txt'),
      await fs.resolve('/data/c.txt'),
      {
        expectedSource: { version: await versionAt(fs, '/data/a.txt') },
        expectedDestination: { kind: 'createIfAbsent' },
      },
    )
    expect(moved.sourceDeleted).toBe(true)
    expect(await client.exists('/data/a.txt')).toBe(false)
    expect(DEC.decode(await client.read('/data/c.txt'))).toBe('alpha\ndelta\n')

    const deleted = await fs.deleteFile(await fs.resolve('/data/c.txt'), {
      version: await versionAt(fs, '/data/c.txt'),
    })
    expect(deleted.before).toBe('alpha\ndelta\n')
    expect(await client.exists('/data/c.txt')).toBe(false)
  })

  it('refuses a stale edit', async () => {
    const { fs, client } = await remoteWorld({ 'a.txt': 'v1' })
    const target = await fs.resolve('/data/a.txt')
    const seen = await versionAt(fs, '/data/a.txt')
    await client.write('/data/a.txt', ENC.encode('v2, changed elsewhere'))
    expect(await errorCode(fs.deleteFile(target, { version: seen }))).toBe('FS_STALE_VERSION')
  })

  it('reports a link through lstat and reads through it', async () => {
    const { fs, client } = await remoteWorld({ 'target.txt': 'linked' })
    await client.shell('ln -s /data/target.txt /data/link.txt')
    const info = await fs.lstat('/data/link.txt')
    expect(info?.type).toBe('symlink')
    expect(await fs.readText(await fs.resolve('/data/link.txt'))).toBe('linked')
  })

  it('refuses a move onto a link that reaches the source, leaf or parent', async () => {
    const { fs, client } = await remoteWorld({ 'a.txt': 'only copy' })
    await client.shell('ln -s /data/a.txt /data/alias.txt && ln -s /data /linked')
    const version = await versionAt(fs, '/data/a.txt')
    for (const onto of ['/data/alias.txt', '/linked/a.txt']) {
      const move = fs.moveFile(await fs.resolve('/data/a.txt'), await fs.resolve(onto), {
        expectedSource: { version },
        expectedDestination: { kind: 'replaceIfVersion', version },
      })
      expect(await errorCode(move)).toBe('FS_SAME_TARGET')
    }
    expect(DEC.decode(await client.read('/data/a.txt'))).toBe('only copy')
  })

  it('maps no host path into a remote world', async () => {
    const { fs } = await remoteWorld()
    expect(fs.processPathFromHostPath('/Users/somebody/project/a.txt')).toBeUndefined()
    expect(fs.sandboxMode).toBeUndefined()
  })

  it('spills a tool result onto the remote workspace', async () => {
    const { ctx, client } = await remoteWorld()
    await ctx.plugin(MirageSpillStore, { dir: '/data/spill' }).await()
    const request: SaveTextSpill = {
      owner: { sessionId: 'session-a' as SessionId },
      source: { kind: 'tool', toolName: 'bash', callId: 'call-1' as ToolCallId, label: 'result' },
      suggestedName: 'bash.txt',
      content: 'the whole output',
    }
    const ref = await (ctx.spillStore as MirageSpillStore).saveText(request)
    expect(String(ref.locator)).toMatch(/^\/data\/spill\/session-[0-9a-f]{12}\//)
    expect(DEC.decode(await client.read(String(ref.locator)))).toBe('the whole output')
  })
})
