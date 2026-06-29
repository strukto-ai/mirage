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
import { changeDir, homeDir } from './shell_dirs.ts'

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
})
