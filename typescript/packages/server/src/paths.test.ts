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
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PathOutsideRootError,
  defaultSnapshotRoot,
  defaultVersionRoot,
  mirageHome,
  pidFilePath,
  resolveWithinRoot,
  validatePathSegment,
} from './paths.ts'

describe('resolveWithinRoot', () => {
  const root = `${sep}srv${sep}snapshots`

  it('accepts a relative path under the root', () => {
    expect(resolveWithinRoot(root, 'seed.tar')).toBe(join(root, 'seed.tar'))
  })

  it('accepts an absolute path inside the root', () => {
    const inside = join(root, 'nested', 'a.tar')
    expect(resolveWithinRoot(root, inside)).toBe(inside)
  })

  it('returns the root itself', () => {
    expect(resolveWithinRoot(root, '.')).toBe(root)
  })

  it('rejects traversal escaping the root', () => {
    expect(() => resolveWithinRoot(root, '../../etc/passwd')).toThrow(PathOutsideRootError)
  })

  it('rejects an absolute path outside the root', () => {
    expect(() => resolveWithinRoot(root, `${sep}etc${sep}passwd`)).toThrow(PathOutsideRootError)
  })

  it('rejects a sibling that shares the root prefix', () => {
    expect(() => resolveWithinRoot(root, `${sep}srv${sep}snapshots-evil${sep}x`)).toThrow(
      PathOutsideRootError,
    )
  })
})

describe('validatePathSegment', () => {
  it('accepts safe segments', () => {
    expect(validatePathSegment('ws_abc123')).toBe('ws_abc123')
    expect(validatePathSegment('a.b-c_d')).toBe('a.b-c_d')
  })

  it('rejects empty, dot, and dotdot', () => {
    expect(() => validatePathSegment('')).toThrow(PathOutsideRootError)
    expect(() => validatePathSegment('.')).toThrow(PathOutsideRootError)
    expect(() => validatePathSegment('..')).toThrow(PathOutsideRootError)
  })

  it('rejects separators and other unsafe characters', () => {
    expect(() => validatePathSegment('a/b')).toThrow(PathOutsideRootError)
    expect(() => validatePathSegment('a\\b')).toThrow(PathOutsideRootError)
    expect(() => validatePathSegment('a b')).toThrow(PathOutsideRootError)
    expect(() => validatePathSegment('a$b')).toThrow(PathOutsideRootError)
  })
})

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

  it('MIRAGE_PID_FILE wins over MIRAGE_HOME', () => {
    expect(
      pidFilePath(undefined, { MIRAGE_HOME: '/data/mirage', MIRAGE_PID_FILE: '/run/m.pid' }),
    ).toBe('/run/m.pid')
  })

  it('explicit argument wins over env', () => {
    expect(pidFilePath('/x/y.pid', { MIRAGE_PID_FILE: '/run/m.pid' })).toBe('/x/y.pid')
  })
})

describe('root defaults follow mirageHome', () => {
  it('version and snapshot roots', () => {
    const env = { MIRAGE_HOME: '/data/mirage' }
    expect(defaultVersionRoot(env)).toBe(join('/data/mirage', 'repos'))
    expect(defaultSnapshotRoot(env)).toBe(join('/data/mirage', 'snapshots'))
  })
})

describe('relative overrides are absolutized', () => {
  it('relative MIRAGE_HOME resolves against cwd', () => {
    expect(mirageHome({ MIRAGE_HOME: 'mhome' })).toBe(resolve('mhome'))
  })

  it('relative MIRAGE_PID_FILE resolves against cwd', () => {
    expect(pidFilePath(undefined, { MIRAGE_PID_FILE: 'rel/daemon.pid' })).toBe(
      resolve('rel/daemon.pid'),
    )
  })

  it('relative explicit pid path resolves against cwd', () => {
    expect(pidFilePath('x.pid', {})).toBe(resolve('x.pid'))
  })
})
