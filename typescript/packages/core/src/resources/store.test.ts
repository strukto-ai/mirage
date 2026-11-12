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

import { describe, expect, it } from 'vitest'
import { MemoryRecords, MemorySealer } from './memory.ts'
import { RecordResourceStore } from './store.ts'
import type { EntryInput, Fields } from './types.ts'

const GITHUB: EntryInput = {
  name: 'github',
  type: 'github',
  fields: { owner: 'x' },
  sealed: { token: 't1' },
}

class FailingRecords extends MemoryRecords {
  fail = false

  override write(folder: string, name: string, record: Fields): Promise<void> {
    if (this.fail) return Promise.reject(new Error('disk full'))
    return super.write(folder, name, record)
  }
}

function store(records = new MemoryRecords()): RecordResourceStore {
  return new RecordResourceStore('t', records, new MemorySealer())
}

describe('RecordResourceStore', () => {
  it('keeps, drops and replaces sealed fields on a put', async () => {
    const s = store()
    await s.createEntry('vfs', GITHUB)
    expect(
      (await s.updateEntry('vfs', { name: 'github', type: 'github', fields: {} })).sealed,
    ).toEqual(['token'])
    const pointer = { token: { from: 'aws', ref: 'r', key: 'k' } }
    expect(
      (await s.updateEntry('vfs', { name: 'github', type: 'github', fields: pointer })).sealed,
    ).toEqual([])
    await s.updateEntry('vfs', {
      name: 'github',
      type: 'github',
      fields: {},
      sealed: { token: 't2', k: 'v' },
    })
    const dropped = await s.updateEntry('vfs', {
      name: 'github',
      type: 'github',
      fields: {},
      sealed: { k: null },
    })
    expect(dropped.sealed).toEqual(['token'])
    expect((await s.revealEntry('vfs', 'github')).sealed).toEqual({ token: 't2' })
  })

  it('brings a deleted entry back without its secret', async () => {
    const s = store()
    await s.createEntry('vfs', GITHUB)
    await s.deleteEntry('vfs', 'github')
    await expect(s.revealEntry('vfs', 'github')).rejects.toMatchObject({ code: 'not_found' })
    expect(
      (await s.createEntry('vfs', { name: 'github', type: 'github', fields: {} })).sealed,
    ).toEqual([])
  })

  it('keeps the old secret when the record write fails', async () => {
    const records = new FailingRecords()
    const s = store(records)
    await s.createEntry('vfs', GITHUB)
    records.fail = true
    await expect(
      s.updateEntry('vfs', { name: 'github', type: 'github', fields: { token: { from: 'aws' } } }),
    ).rejects.toThrow('disk full')
    expect((await s.revealEntry('vfs', 'github')).sealed).toEqual({ token: 't1' })
  })

  it('keeps a sealed field of any name', async () => {
    const s = store()
    const sealed = JSON.parse('{"__proto__": "p"}') as Record<string, string>
    const entry = await s.createEntry('vfs', { name: 'odd', type: 't', fields: {}, sealed })
    expect(entry.sealed).toEqual(['__proto__'])
    expect(Object.hasOwn((await s.revealEntry('vfs', 'odd')).sealed, '__proto__')).toBe(true)
  })

  it('holds an entry name once across kinds', async () => {
    const s = store()
    await s.createEntry('vfs', GITHUB)
    await expect(
      s.createEntry('cli', { name: 'github', type: 'gh', fields: {} }),
    ).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  it.each(['../x', 'Upper', '', 'a'.repeat(64)])(
    'refuses the name %j on every call',
    async (name) => {
      const s = store()
      for (const call of [
        () => s.getEntry('vfs', name),
        () => s.deleteEntry('vfs', name),
        () => s.deletePolicy(name),
        () => s.deleteTemplate(name),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'invalid' })
      }
    },
  )

  it('refuses a create of a taken name and an update of a missing one', async () => {
    const s = store()
    await s.createEntry('vfs', GITHUB)
    await s.createPolicy({ name: 'guard.py', source: 'pass' })
    await expect(s.createEntry('vfs', GITHUB)).rejects.toMatchObject({ code: 'conflict' })
    await expect(s.createPolicy({ name: 'guard.py', source: 'x' })).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(
      s.updateEntry('vfs', { name: 'nope', type: 'github', fields: {} }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(s.updatePolicy({ name: 'nope.py', source: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    })
    expect((await s.getPolicy('guard.py')).source).toBe('pass')
  })

  it('does not delete an entry a template names', async () => {
    const s = store()
    await s.createEntry('vfs', GITHUB)
    const token = { from: 'strukto', ref: 'github', key: 'token' }
    await s.createTemplate({
      name: 'agent',
      config: { mounts: { '/gh': { vfs: 'github', config: { token } } } },
    })
    await expect(s.deleteEntry('vfs', 'github')).rejects.toMatchObject({
      code: 'conflict',
      message: 'github is used by agent',
    })
    await s.deleteTemplate('agent')
    await s.deleteEntry('vfs', 'github')
  })

  it('saves one of two creates of one template', async () => {
    const s = store()
    const results = await Promise.allSettled([
      s.createTemplate({ name: 't', config: { a: 1 } }),
      s.createTemplate({ name: 't', config: { a: 2 } }),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    expect((await s.getTemplate('t')).config).toEqual({ a: 1 })
  })
})
