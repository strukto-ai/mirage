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
import { changeDir, homeDir, logicalCwd, setCwd } from './shell_dirs.ts'

describe('shell_dirs', () => {
  it('homeDir is null when $HOME unset', () => {
    expect(homeDir(new Session({ sessionId: 's' }))).toBeNull()
  })

  it('homeDir reads $HOME', () => {
    expect(homeDir(new Session({ sessionId: 's', env: { HOME: '/data' } }))).toBe('/data')
  })

  it('homeDir is null for empty $HOME', () => {
    expect(homeDir(new Session({ sessionId: 's', env: { HOME: '' } }))).toBeNull()
  })

  it('changeDir sets cwd and $OLDPWD', () => {
    const s = new Session({ sessionId: 's', cwd: '/data' })
    changeDir(s, '/data/sub')
    expect(s.cwd).toBe('/data/sub')
    expect(s.env.OLDPWD).toBe('/data')
  })

  it('changeDir overwrites $OLDPWD', () => {
    const s = new Session({ sessionId: 's', cwd: '/a' })
    changeDir(s, '/b')
    changeDir(s, '/c')
    expect(s.cwd).toBe('/c')
    expect(s.env.OLDPWD).toBe('/b')
  })

  it('logicalCwd falls back to the physical cwd', () => {
    expect(logicalCwd(new Session({ sessionId: 's', cwd: '/data' }))).toBe('/data')
  })

  it('changeDir records a logical name that differs', () => {
    const s = new Session({ sessionId: 's', cwd: '/data' })
    changeDir(s, '/data/deep/real', '/data/lk')
    expect(s.cwd).toBe('/data/deep/real')
    expect(logicalCwd(s)).toBe('/data/lk')
  })

  // Storing the two names as one collapsed field keeps `logicalCwd` from
  // reporting a stale spelling after a `-P` move.
  it('changeDir collapses the pair when the names agree', () => {
    const s = new Session({ sessionId: 's', cwd: '/data' })
    changeDir(s, '/data/deep/real', '/data/lk')
    changeDir(s, '/data/deep/real', '/data/deep/real')
    expect(s.logicalCwd).toBeUndefined()
    expect(logicalCwd(s)).toBe('/data/deep/real')
  })

  it('$OLDPWD records the logical name, which is what `cd -` returns to', () => {
    const s = new Session({ sessionId: 's', cwd: '/data' })
    changeDir(s, '/data/deep/real', '/data/lk')
    changeDir(s, '/tmp')
    expect(s.env.OLDPWD).toBe('/data/lk')
  })

  // A snapshot restore or `workspace.cwd = ...` moves the session with no
  // typed spelling behind it. Leaving the old logical name would make
  // `pwd` describe a directory the session is no longer in.
  it('setCwd drops a stale logical name', () => {
    const s = new Session({ sessionId: 's', cwd: '/data' })
    changeDir(s, '/data/deep/real', '/data/lk')
    setCwd(s, '/elsewhere')
    expect(s.logicalCwd).toBeUndefined()
    expect(logicalCwd(s)).toBe('/elsewhere')
  })

  it('setCwd leaves $OLDPWD alone', () => {
    const s = new Session({ sessionId: 's', cwd: '/data' })
    setCwd(s, '/elsewhere')
    expect(s.env.OLDPWD).toBeUndefined()
  })
})
