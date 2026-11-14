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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isMissingPath } from '@struktoai/mirage-core/errors/fs'
import { FileType } from '@struktoai/mirage-core/types'
import { AuthMode, buildApp } from '@struktoai/mirage-server'
import { MirageClient, MirageRemoteError } from './client.ts'

const RAM = { config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } }
const TOKEN = 'dsh-remote-test'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let root: string
let app: ReturnType<typeof buildApp>
let url: string
let client: MirageClient

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-remote-'))
  app = buildApp({
    stateRoot: join(root, 'state'),
    authConfig: { mode: AuthMode.Local, localToken: TOKEN },
  })
  url = await app.listen({ port: 0, host: '127.0.0.1' })
  const made = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    payload: RAM,
    headers: AUTH,
  })
  client = new MirageClient({ url, workspace: made.json<{ id: string }>().id, token: TOKEN })
})

afterAll(async () => {
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

describe('MirageClient', () => {
  it('runs a line and streams its output', async () => {
    const seen: string[] = []
    const result = await client.shell('echo out; echo err >&2; exit 3', {
      onOutput: (channel, data) => {
        seen.push(`${channel}:${new TextDecoder().decode(data)}`)
        return Promise.resolve()
      },
    })
    expect(result.exitCode).toBe(3)
    expect(result.stdoutText).toBe('out\n')
    expect(result.stderrText).toBe('err\n')
    expect(result.decision).toBeNull()
    expect(seen).toEqual(expect.arrayContaining(['stdout:out\n', 'stderr:err\n']))
  })

  it('feeds stdin and runs in a cwd', async () => {
    await client.mkdir('/work')
    const result = await client.shell('pwd; cat', {
      cwd: '/work',
      stdin: new TextEncoder().encode('fed\n'),
    })
    expect(result.stdoutText).toBe('/work\nfed\n')
  })

  it('keeps a session between lines', async () => {
    await client.createSession('agent')
    await client.shell('cd /work && export TOKEN=abc', { sessionId: 'agent' })
    const result = await client.shell('pwd; echo $TOKEN', { sessionId: 'agent' })
    expect(result.stdoutText).toBe('/work\nabc\n')
    const listed = await client.sessions()
    expect(listed).toContainEqual({ sessionId: 'agent', cwd: '/work' })
  })

  it('reads, writes and lists files', async () => {
    await client.write('/work/a.txt', new TextEncoder().encode('hello'))
    await client.append('/work/a.txt', new TextEncoder().encode(' world'))
    expect(new TextDecoder().decode(await client.read('/work/a.txt'))).toBe('hello world')
    expect(new TextDecoder().decode(await client.read('/work/a.txt', { offset: 6, size: 3 }))).toBe(
      'wor',
    )
    const stat = await client.stat('/work/a.txt')
    expect(stat.type).toBe(FileType.FILE)
    expect(stat.size).toBe(11)
    expect(await client.readdir('/work')).toContain('/work/a.txt')
    expect(await client.isDir('/work')).toBe(true)
    expect(await client.exists('/work/missing')).toBe(false)
    await client.rename('/work/a.txt', '/work/b.txt')
    await client.unlink('/work/b.txt')
    expect(await client.exists('/work/b.txt')).toBe(false)
  })

  it('answers a missing path as mirage would', async () => {
    const err = await client.read('/nope.txt').catch((e: unknown) => e)
    expect(isMissingPath(err)).toBe(true)
    expect((err as { virtualPath?: string }).virtualPath).toBe('/nope.txt')
  })

  it('reads a symlink and answers null for a plain file', async () => {
    await client.write('/work/target.txt', new TextEncoder().encode('t'))
    await client.shell('ln -s /work/target.txt /work/link.txt')
    expect(await client.readlink('/work/link.txt')).toBe('/work/target.txt')
    expect(await client.readlink('/work/target.txt')).toBeNull()
  })

  it('cancels a line when its signal aborts', async () => {
    const controller = new AbortController()
    const running = client.shell('sleep 30', { signal: controller.signal })
    setTimeout(() => {
      controller.abort(new Error('stop'))
    }, 200)
    await expect(running).rejects.toThrow()
  })

  it('names a server failure', async () => {
    const other = new MirageClient({ url, workspace: 'no-such-workspace', token: TOKEN })
    const err = await other.shell('true').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MirageRemoteError)
    expect((err as MirageRemoteError).status).toBe(404)
  })
})
