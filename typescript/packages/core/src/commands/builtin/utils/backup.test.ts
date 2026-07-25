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
import { PathSpec, type ReaddirFn } from '../../../types.ts'
import { backupControl, backupTarget, parentPath, siblingPath } from './backup.ts'

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resourcePath: path.replace(/^\/+|\/+$/g, ''),
  })
}

function listing(children: string[]): ReaddirFn {
  return () => Promise.resolve(children)
}

describe('backupControl', () => {
  it('resolves aliases and the env-less default', () => {
    expect(backupControl('cp', true, null)).toBe('existing')
    expect(backupControl('cp', undefined, null)).toBeNull()
    expect(backupControl('cp', false, null)).toBeNull()
    expect(backupControl('cp', 't', null)).toBe('numbered')
    expect(backupControl('cp', 'numbered', null)).toBe('numbered')
    expect(backupControl('cp', 'nil', null)).toBe('existing')
    expect(backupControl('cp', 'never', null)).toBe('simple')
    expect(backupControl('cp', 'off', null)).toBe('none')
    // -S SUFFIX alone enables backups (GNU 9.7).
    expect(backupControl('cp', undefined, '.bak')).toBe('existing')
  })

  it('rejects an invalid control with the GNU listing', () => {
    let message = ''
    try {
      backupControl('mv', 'bogus', null)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain("mv: invalid argument 'bogus' for 'backup type'")
    expect(message).toContain("  - 'none', 'off'")
    expect(message).toContain("Try 'mv --help' for more information.")
  })
})

describe('siblingPath and parentPath', () => {
  it('appends to the name and walks to the parent on the same mount', () => {
    const target = spec('/data/sub/b.txt')
    const backup = siblingPath(target, '~')
    expect(backup.virtual).toBe('/data/sub/b.txt~')
    expect(backup.resourcePath).toBe('data/sub/b.txt~')
    const parent = parentPath(target)
    expect(parent.virtual).toBe('/data/sub')
    expect(parent.resourcePath).toBe('data/sub')
    expect(parentPath(spec('/b.txt')).virtual).toBe('/')
  })
})

describe('backupTarget', () => {
  it('simple appends the suffix', async () => {
    const picked = await backupTarget(undefined, spec('/d/b.txt'), 'simple', '~')
    expect(picked?.virtual).toBe('/d/b.txt~')
  })

  it('none picks no backup', async () => {
    expect(await backupTarget(undefined, spec('/d/b.txt'), 'none', '~')).toBeNull()
  })

  it('numbered scans existing versions', async () => {
    const lister = listing(['/d/b.txt', '/d/b.txt.~1~', '/d/b.txt.~7~'])
    const picked = await backupTarget(lister, spec('/d/b.txt'), 'numbered', '~')
    expect(picked?.virtual).toBe('/d/b.txt.~8~')
  })

  it('existing falls back to simple without numbered versions', async () => {
    const picked = await backupTarget(listing(['/d/b.txt']), spec('/d/b.txt'), 'existing', '.bak')
    expect(picked?.virtual).toBe('/d/b.txt.bak')
  })

  it('existing stays numbered while numbered versions exist', async () => {
    const lister = listing(['/d/b.txt', '/d/b.txt.~2~'])
    const picked = await backupTarget(lister, spec('/d/b.txt'), 'existing', '~')
    expect(picked?.virtual).toBe('/d/b.txt.~3~')
  })

  it('ignores versions of other names', async () => {
    const lister = listing(['/d/bb.txt.~4~', '/d/b.txt.bak', '/d/b.txt~'])
    const picked = await backupTarget(lister, spec('/d/b.txt'), 'existing', '~')
    expect(picked?.virtual).toBe('/d/b.txt~')
  })
})
