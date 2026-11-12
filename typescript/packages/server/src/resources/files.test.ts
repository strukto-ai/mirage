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

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { filesResourceStore } from './files.ts'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'mirage-resources-'))
}

describe('filesResourceStore', () => {
  it('keeps sealed values apart, in owner-only files', async () => {
    const dir = root()
    await filesResourceStore(dir).createEntry('cli', {
      name: 'gh',
      type: 'gh',
      fields: { a: 1 },
      sealed: { token: 'secret-x' },
    })
    const sealed = join(dir, '.sealed', 'cli', 'gh.json')
    expect(statSync(sealed).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, '.sealed', 'cli')).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(dir, 'cli', 'gh.yaml'), 'utf-8')).not.toContain('secret-x')
    expect((await filesResourceStore(dir).revealEntry('cli', 'gh')).sealed).toEqual({
      token: 'secret-x',
    })
  })

  it('reads a string back as a string', async () => {
    const dir = root()
    const config = { mounts: { '/': { vfs: 'ram', mode: 'off', ttl: '1e3' } } }
    await filesResourceStore(dir).putTemplate({ name: 't', config })
    expect((await filesResourceStore(dir).getTemplate('t')).config).toEqual(config)
  })

  it('reads a hand-edited file as YAML, or refuses it', async () => {
    const dir = root()
    const store = filesResourceStore(dir)
    mkdirSync(join(dir, 'policy'))
    writeFileSync(join(dir, 'policy', 'a.py.yaml'), 'name: a.py\nsource: x\n')
    expect((await store.getPolicy('a.py')).source).toBe('x')
    writeFileSync(join(dir, 'policy', 'c.py.yaml'), '{source: allow}\n')
    expect((await store.getPolicy('c.py')).source).toBe('allow')
    writeFileSync(join(dir, 'policy', 'b.py.yaml'), 'source: [\n')
    await expect(store.getPolicy('b.py')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('never quotes a malformed sealed file', async () => {
    const dir = root()
    const store = filesResourceStore(dir)
    await store.createEntry('cli', {
      name: 'gh',
      type: 'gh',
      fields: {},
      sealed: { token: 'secret-x' },
    })
    writeFileSync(join(dir, '.sealed', 'cli', 'gh.json'), 'token: [secret-x\n')
    await expect(store.revealEntry('cli', 'gh')).rejects.toMatchObject({
      code: 'invalid',
      message: expect.not.stringContaining('secret-x') as string,
    })
  })

  it('writes records owner only', async () => {
    const dir = root()
    await filesResourceStore(dir).putTemplate({ name: 't', config: { env: { TOKEN: 'x' } } })
    expect(statSync(join(dir, 'template', 't.yaml')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'template')).mode & 0o777).toBe(0o700)
  })

  it('keeps a hand-edited date as a string', async () => {
    const dir = root()
    const store = filesResourceStore(dir)
    mkdirSync(join(dir, 'template'))
    writeFileSync(join(dir, 'template', 't.yaml'), 'name: t\nconfig: {since: 2020-01-01}\n')
    expect((await store.getTemplate('t')).config).toEqual({ since: '2020-01-01' })
  })
})
