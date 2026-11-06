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

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { memoryResourceStore } from '@struktoai/mirage-core/resources/memory'
import type { MirageApp } from '@struktoai/mirage-server'
import { AuthMode } from '@struktoai/mirage-server/auth/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { missingRequired, oneLine, secretSource, setValue } from './connections.ts'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'mirage.js')

let app: MirageApp
let store: ResourceStore
let url = ''
let home = ''

beforeAll(async () => {
  store = memoryResourceStore()
  const { buildApp } = await import('@struktoai/mirage-server')
  app = buildApp({
    idleGraceSeconds: 10,
    resourceStore: store,
    authConfig: { mode: AuthMode.Local, localToken: 'tk' },
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  url = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`
  home = mkdtempSync(join(tmpdir(), 'mirage-connections-'))
})

afterAll(async () => {
  await app.close()
  rmSync(home, { recursive: true, force: true })
})

function run(args: string[], stdin = ''): Promise<{ code: number; out: string; err: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MIRAGE_HOME: home,
    MIRAGE_DAEMON_URL: url,
    MIRAGE_TOKEN: 'tk',
  }
  const child = spawn(process.execPath, [BIN, ...args], { env })
  let out = ''
  let err = ''
  child.stdout.on('data', (c: Buffer) => (out += c.toString()))
  child.stderr.on('data', (c: Buffer) => (err += c.toString()))
  child.stdin.end(stdin)
  return new Promise((resolve) =>
    child.on('close', (code) => {
      resolve({ code: code ?? 0, out, err })
    }),
  )
}

const GH = ['--type', 'github', '--set', 'owner=o', '--set', 'repo=r']

describe('input rules', () => {
  it('parses --set and --secret words', () => {
    expect(setValue('a=b=c')).toEqual(['a', 'b=c'])
    expect(setValue('a={"x":1}')).toEqual(['a', { x: 1 }])
    expect(secretSource('token')).toEqual(['token', null])
    expect(secretSource('token=@/k')).toEqual(['token', '/k'])
    expect(oneLine('v\n')).toBe('v')
    expect(oneLine('v\n\n')).toBe('v\n')
  })

  it('names a block field only when the block is used', () => {
    const spec = [
      { name: 'url', type: 'string', required: true },
      { name: 'auth.type', type: 'string', required: true, group: 'auth' },
      { name: 'auth.token', type: 'string', required: true, group: 'auth' },
    ]
    expect(missingRequired(spec, new Set())).toEqual(['url'])
    expect(missingRequired(spec, new Set(['url', 'auth.type']))).toEqual(['auth.token'])
  })
})

describe('mirage vfs against a daemon', () => {
  it('reads a secret from stdin and never from argv', async () => {
    const made = await run(['vfs', 'create', 'github', ...GH, '--secret', 'token'], 'ghp_x\n')
    expect(made.err).toBe('')
    expect(made.code).toBe(0)
    expect((await store.revealEntry('vfs', 'github')).sealed).toEqual({ token: 'ghp_x' })
    const argv = await run(['vfs', 'create', 'x', ...GH, '--secret', 'token=v'])
    expect(argv.code).toBe(2)
    expect(argv.err).toContain('never comes from the command line')
    const set = await run(['vfs', 'create', 'x', ...GH, '--set', 'token=v'])
    expect(set.code).toBe(2)
    expect(set.err).toContain('never comes from the command line')
  })

  it('names the missing required fields without a terminal', async () => {
    const r = await run(['cli', 'create', 'm', '--type', 'mcp'])
    expect(r.code).toBe(2)
    expect(r.err).toContain('missing required fields: url')
  })

  it('reads a secret file, keeps fields on update and removes one with --unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-secret-'))
    const key = join(dir, 'token')
    writeFileSync(key, 't1\n')
    expect((await run(['vfs', 'create', 'gh', ...GH, '--secret', `token=@${key}`])).code).toBe(0)
    expect((await store.revealEntry('vfs', 'gh')).sealed).toEqual({ token: 't1' })
    expect((await run(['vfs', 'update', 'gh', '--secret', 'token'], 't2\n')).code).toBe(0)
    const got = JSON.parse((await run(['vfs', 'get', 'gh', '-o', 'json'])).out) as {
      config: unknown
      sealed: string[]
    }
    expect(got.config).toEqual({ owner: 'o', repo: 'r' })
    expect(got.sealed).toEqual(['token'])
    expect((await store.revealEntry('vfs', 'gh')).sealed).toEqual({ token: 't2' })
    const unset = await run(['vfs', 'update', 'gh', '--unset', 'token'])
    expect(unset.code).toBe(2)
    expect(unset.err).toContain('token is required')
    rmSync(dir, { recursive: true, force: true })
  })

  it('takes an entry from a file, whose secrets list is read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-entry-'))
    const file = join(dir, 'e.yaml')
    writeFileSync(
      file,
      'name: fromfile\ntype: github\nfields:\n  owner: o\n  repo: r\nsecrets: [token]\n',
    )
    expect((await run(['vfs', 'create', '-f', file], 't\n')).code).toBe(0)
    expect((await store.revealEntry('vfs', 'fromfile')).sealed).toEqual({ token: 't' })
    const yaml = (await run(['vfs', 'get', 'fromfile', '-o', 'yaml'])).out
    expect(yaml).toContain('owner: o')
    expect(yaml).not.toContain('token: t')
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists types and deletes', async () => {
    const types = await run(['vfs', 'types', 'github', '-o', 'json'])
    const token = (JSON.parse(types.out) as { name: string; secret: boolean }[]).find(
      (f) => f.name === 'token',
    )
    expect(token?.secret).toBe(true)
    expect((await run(['vfs', 'types', 'nope'])).code).toBe(2)
    expect((await run(['vfs', 'create', 'gone', ...GH, '--secret', 'token'], 't\n')).code).toBe(0)
    const listed = JSON.parse((await run(['vfs', 'list', '-o', 'json'])).out) as {
      items: { name: string }[]
    }
    expect(listed.items.map((i) => i.name)).toContain('gone')
    const del = await run(['vfs', 'delete', 'gone'])
    expect(del.out).toBe('Deleted VFS gone.\n')
    const after = await run(['vfs', 'get', 'gone'])
    expect(after.code).toBe(2)
    expect(after.err).toContain('VFS not found')
  })
})
