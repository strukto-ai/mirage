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
import { Session } from './session.ts'
import { MountMode } from '../../types.ts'

describe('Session', () => {
  it('defaults cwd=/ and empty env', () => {
    const s = new Session({ sessionId: 'x' })
    expect(s.cwd).toBe('/')
    expect(s.env).toEqual({})
    expect(s.functions).toEqual({})
    expect(s.lastExitCode).toBe(0)
  })

  it('cwd and env are mutable', () => {
    const s = new Session({ sessionId: 'x' })
    s.cwd = '/data'
    s.env = { FOO: 'bar' }
    expect(s.cwd).toBe('/data')
    expect(s.env.FOO).toBe('bar')
  })

  it('toJSON includes only the serializable fields, snake_case like Python', () => {
    const s = new Session({ sessionId: 'x', cwd: '/a', env: { K: 'V' } })
    const json = s.toJSON()
    expect(json).toEqual({
      session_id: 'x',
      cwd: '/a',
      env: { K: 'V' },
      created_at: s.createdAt,
      generation: 0,
    })
    expect('functions' in json).toBe(false)
    expect('lastExitCode' in json).toBe(false)
  })

  it('fromJSON round-trips', () => {
    const original = new Session({ sessionId: 'x', cwd: '/a', env: { K: 'V' } })
    const restored = Session.fromJSON(
      original.toJSON() as {
        session_id: string
        cwd: string
        env: Record<string, string>
        created_at: number
      },
    )
    expect(restored.sessionId).toBe('x')
    expect(restored.cwd).toBe('/a')
    expect(restored.env).toEqual({ K: 'V' })
  })

  it('round-trips mountModes through toJSON/fromJSON', () => {
    const original = new Session({
      sessionId: 'x',
      mountModes: new Map([
        ['/s3', MountMode.READ],
        ['/scratch', MountMode.WRITE],
      ]),
    })
    const json = original.toJSON()
    expect(json.mount_modes).toEqual({ '/s3': 'read', '/scratch': 'write' })
    const restored = Session.fromJSON(
      json as { session_id: string; mount_modes?: Record<string, MountMode> | null },
    )
    expect(restored.mountModes?.get('/s3')).toBe(MountMode.READ)
    expect(restored.mountModes?.get('/scratch')).toBe(MountMode.WRITE)
  })

  it('toJSON omits mount_modes when unrestricted', () => {
    const s = new Session({ sessionId: 'x' })
    expect('mount_modes' in s.toJSON()).toBe(false)
    expect(Session.fromJSON({ session_id: 'x' }).mountModes).toBeNull()
  })
})

describe('Session.fork', () => {
  it('copies every field, including mountModes and shellOptions', () => {
    const original = new Session({
      sessionId: 'orig',
      cwd: '/disk',
      env: { FOO: 'bar' },
      mountModes: new Map([
        ['/s3', MountMode.READ],
        ['/dev', MountMode.EXEC],
        ['/', MountMode.EXEC],
      ]),
      shellOptions: { errexit: true },
      readonlyVars: new Set(['HOME']),
      arrays: { ARGV: ['a', 'b'] },
      positionalArgs: ['x'],
      lastExitCode: 7,
    })
    const forked = original.fork({})
    expect(forked.sessionId).toBe('orig')
    expect(forked.cwd).toBe('/disk')
    expect(forked.env).toEqual({ FOO: 'bar' })
    expect(forked.mountModes).toBe(original.mountModes)
    expect(forked.shellOptions).toEqual({ errexit: true })
    expect(forked.readonlyVars.has('HOME')).toBe(true)
    expect(forked.arrays).toEqual({ ARGV: ['a', 'b'] })
    expect(forked.positionalArgs).toEqual(['x'])
    expect(forked.lastExitCode).toBe(7)
  })

  it('applies overrides without mutating the original', () => {
    const original = new Session({
      sessionId: 'orig',
      cwd: '/disk',
      env: { FOO: 'bar' },
    })
    const forked = original.fork({ cwd: '/ram', env: { BAZ: 'qux' } })
    expect(forked.cwd).toBe('/ram')
    expect(forked.env).toEqual({ BAZ: 'qux' })
    expect(original.cwd).toBe('/disk')
    expect(original.env).toEqual({ FOO: 'bar' })
  })

  it('deep-copies mutable containers so mutations on the fork do not leak', () => {
    const original = new Session({
      sessionId: 'orig',
      env: { FOO: 'bar' },
      arrays: { A: ['1'] },
    })
    const forked = original.fork({})
    forked.env.NEW = 'leaked?'
    forked.arrays.A?.push('2')
    expect('NEW' in original.env).toBe(false)
    expect(original.arrays.A).toEqual(['1'])
  })
})
