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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const seen: { method: string; path: string; body: unknown }[] = []

function json(status: number, value: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(value), { status }))
}
const saved = new Map<string, string>()

vi.mock('./client.ts', () => ({
  makeClient: () => ({
    ensureRunning: () => Promise.resolve(),
    request: (method: string, path: string, init: { body?: string }) => {
      const body = init.body === undefined ? undefined : (JSON.parse(init.body) as unknown)
      seen.push({ method, path, body })
      const name = decodeURIComponent(path.replace(/^\/v1\/policies\/?/, ''))
      if (method === 'GET' && name === '') {
        return json(200, { items: [...saved.keys()].sort().map((n) => ({ name: n })) })
      }
      if (method === 'POST') {
        const b = body as { name: string; source: string }
        saved.set(b.name, b.source)
        return json(201, b)
      }
      if (method === 'PUT') saved.set(name, (body as { source: string }).source)
      if (method === 'DELETE') {
        saved.delete(name)
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return json(200, { name, source: saved.get(name) })
    },
  }),
}))

const { itemsOf, readSource, registerPolicyCommands } = await import('./policy.ts')

let out = ''
const dirs: string[] = []

beforeEach(() => {
  out = ''
  seen.length = 0
  saved.clear()
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function run(...args: string[]): Promise<void> {
  const program = new Command()
  registerPolicyCommands(program)
  await program.parseAsync(['policy', ...args], { from: 'user' })
}

describe('mirage policy', () => {
  it('creates a policy from a file and reads it back as yaml or json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-policy-'))
    dirs.push(dir)
    const file = join(dir, 'guard.py')
    writeFileSync(file, 'x = 1\n')
    await run('create', 'guard.py', '--source', `@${file}`)
    expect(saved.get('guard.py')).toBe('x = 1\n')
    out = ''
    await run('get', 'guard.py')
    expect(JSON.parse(out)).toEqual({ name: 'guard.py', source: 'x = 1\n' })
    out = ''
    await run('get', 'guard.py', '-o', 'yaml')
    expect(out).toContain('name: guard.py')
  })

  it('lists, updates and deletes through the routes', async () => {
    await run('create', 'a.py', '--source', 'x = 1')
    out = ''
    await run('list')
    expect(JSON.parse(out)).toEqual([{ name: 'a.py' }])
    await run('update', 'a.py', '--source', 'x = 2')
    expect(saved.get('a.py')).toBe('x = 2')
    await run('delete', 'a.py')
    expect(saved.size).toBe(0)
    expect(seen.map((s) => [s.method, s.path])).toEqual([
      ['POST', '/v1/policies'],
      ['GET', '/v1/policies'],
      ['PUT', '/v1/policies/a.py'],
      ['DELETE', '/v1/policies/a.py'],
    ])
  })

  it('reads a source as text unless it starts with @, and a list either way', () => {
    expect(readSource('x = 1')).toBe('x = 1')
    expect(itemsOf([{ name: 'a.py' }])).toEqual([{ name: 'a.py' }])
    expect(itemsOf({ items: [{ name: 'b.py' }] })).toEqual([{ name: 'b.py' }])
  })
})
