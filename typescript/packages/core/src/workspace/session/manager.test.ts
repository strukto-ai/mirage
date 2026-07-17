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
import { MountMode } from '../../types.ts'
import { SessionManager } from './manager.ts'
import { RAMSessionStore } from './ram.ts'

describe('SessionManager', () => {
  it('seeds the default session on construction', () => {
    const m = new SessionManager('def')
    expect(m.defaultId).toBe('def')
    expect(m.get('def').sessionId).toBe('def')
    expect(m.list()).toHaveLength(1)
  })

  it('adoptDefault re-keys the placeholder before hydration', () => {
    const m = new SessionManager('minted')
    m.get('minted').cwd = '/kept'
    m.adoptDefault('stored')
    expect(m.defaultId).toBe('stored')
    expect(m.get('stored').cwd).toBe('/kept')
    expect(m.list()).toHaveLength(1)
    expect(() => m.get('minted')).toThrow()
  })

  it('adoptDefault switches to an existing session of that id', () => {
    const m = new SessionManager('minted')
    m.create('stored')
    m.adoptDefault('stored')
    expect(m.defaultId).toBe('stored')
    expect(m.list()).toHaveLength(1)
  })

  it('exposes cwd and env for the default session', () => {
    const m = new SessionManager('def')
    m.cwd = '/data'
    m.env = { K: 'V' }
    expect(m.cwd).toBe('/data')
    expect(m.env.K).toBe('V')
    expect(m.get('def').cwd).toBe('/data')
  })

  it('create adds a new session', () => {
    const m = new SessionManager('def')
    const s = m.create('sub')
    expect(s.sessionId).toBe('sub')
    expect(
      m
        .list()
        .map((x) => x.sessionId)
        .sort(),
    ).toEqual(['def', 'sub'])
  })

  it('create throws on duplicate', () => {
    const m = new SessionManager('def')
    m.create('sub')
    expect(() => m.create('sub')).toThrow(/already exists/)
  })

  it('get throws on unknown', () => {
    const m = new SessionManager('def')
    expect(() => m.get('nope')).toThrow(/unknown session/)
  })

  it('close removes a non-default session', async () => {
    const m = new SessionManager('def')
    m.create('sub')
    await m.close('sub')
    expect(m.list().map((x) => x.sessionId)).toEqual(['def'])
  })

  it('close throws on the default session', async () => {
    const m = new SessionManager('def')
    await expect(m.close('def')).rejects.toThrow(/Cannot close the default session/)
  })

  it('closeAll keeps default but drops others', async () => {
    const m = new SessionManager('def')
    m.create('a')
    m.create('b')
    await m.closeAll()
    expect(m.list().map((x) => x.sessionId)).toEqual(['def'])
  })
})

describe('SessionManager with a SessionStore', () => {
  it('hydrates stored sessions on ensureLoaded', async () => {
    const store = new RAMSessionStore()
    await store.set('restored', {
      session_id: 'restored',
      cwd: '/w',
      env: { K: 'v' },
      created_at: 1.0,
      mount_modes: { '/data': 'read' },
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const s = m.get('restored')
    expect(s.cwd).toBe('/w')
    expect(s.env).toEqual({ K: 'v' })
    expect(s.mountModes?.get('/data')).toBe(MountMode.READ)
  })

  it('locally created sessions win a hydration conflict', async () => {
    const store = new RAMSessionStore()
    await store.set('s1', { session_id: 's1', cwd: '/stale' })
    const m = new SessionManager('def', store)
    const local = m.create('s1')
    local.cwd = '/fresh'
    await m.ensureLoaded()
    expect(m.get('s1').cwd).toBe('/fresh')
  })

  it('default session adopts stored durable fields', async () => {
    const store = new RAMSessionStore()
    await store.set('def', { session_id: 'def', cwd: '/w', env: { A: '1' } })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    expect(m.cwd).toBe('/w')
    expect(m.env).toEqual({ A: '1' })
  })

  it('flush writes every session through', async () => {
    const store = new RAMSessionStore()
    const m = new SessionManager('def', store)
    m.create('agent', { mountModes: new Map([['/s3', MountMode.READ]]) })
    m.cwd = '/moved'
    await m.flush()
    const entries = await store.load()
    expect(entries.get('def')?.cwd).toBe('/moved')
    expect(entries.get('agent')?.mount_modes).toEqual({ '/s3': 'read' })
  })

  it('close deletes the session from the store', async () => {
    const store = new RAMSessionStore()
    const m = new SessionManager('def', store)
    m.create('gone')
    await m.flush()
    await m.close('gone')
    expect((await store.load()).has('gone')).toBe(false)
  })
})
