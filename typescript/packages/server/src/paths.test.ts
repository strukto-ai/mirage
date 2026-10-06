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

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mirageHome, pidFilePath, stateRootPath } from './paths.ts'

describe('mirageHome', () => {
  it('defaults to ~/.mirage', () => {
    expect(mirageHome({})).toBe(join(homedir(), '.mirage'))
  })

  it('honors MIRAGE_HOME', () => {
    expect(mirageHome({ MIRAGE_HOME: '/data/mirage' })).toBe('/data/mirage')
  })
})

describe('pidFilePath', () => {
  it('defaults under mirageHome', () => {
    expect(pidFilePath(undefined, { MIRAGE_HOME: '/data/mirage' })).toBe(
      join('/data/mirage', 'daemon.pid'),
    )
  })

  it('explicit argument wins over home', () => {
    expect(pidFilePath('/x/y.pid', { MIRAGE_HOME: '/data/mirage' })).toBe('/x/y.pid')
  })
})

describe('the state root follows mirageHome', () => {
  it('defaults under the home', () => {
    const env = { MIRAGE_HOME: '/data/mirage' }
    expect(stateRootPath(undefined, env)).toBe(join('/data/mirage', 'state'))
  })

  it('explicit argument wins over home', () => {
    const env = { MIRAGE_HOME: '/data/mirage' }
    expect(stateRootPath('/explicit/state', env)).toBe(resolve('/explicit/state'))
  })
})

describe('relative overrides are absolutized', () => {
  it('relative MIRAGE_HOME resolves against cwd', () => {
    expect(mirageHome({ MIRAGE_HOME: 'mhome' })).toBe(resolve('mhome'))
  })

  it('relative explicit pid path resolves against cwd', () => {
    expect(pidFilePath('x.pid', {})).toBe(resolve('x.pid'))
  })
})
