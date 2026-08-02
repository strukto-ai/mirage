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

import { RAMResource } from '../../../resource/ram/ram.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { MountRegistry } from '../../mount/registry.ts'
import { checkMountRootGuard } from './guard.ts'

function registry(): MountRegistry {
  return new MountRegistry({ '/data': new RAMResource() }, MountMode.WRITE, {})
}

function path(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: '', resolved: true })
}

describe('checkMountRootGuard', () => {
  it.each([
    ['rm', 'Device or resource busy'],
    ['rmdir', 'Device or resource busy'],
    ['mv', 'Device or resource busy'],
    ['mkdir', 'File exists'],
    ['touch', 'Is a directory'],
    ['ln', 'File exists'],
  ])('refuses %s on a mount root', (cmd, needle) => {
    const result = checkMountRootGuard(cmd, [path('/data')], registry(), [])
    expect(result).not.toBeNull()
    expect(result?.message).toContain(needle)
    expect(result?.exitCode).toBe(1)
  })

  it('treats mkdir -p on a mount root as a no-op', () => {
    const reg = registry()
    for (const argv of [['-p'], ['--parents'], ['-pv']]) {
      expect(checkMountRootGuard('mkdir', [path('/data')], reg, argv)).toBeNull()
    }
  })

  it('passes non-root paths', () => {
    const reg = registry()
    for (const cmd of ['rm', 'rmdir', 'mv', 'mkdir', 'touch', 'ln']) {
      expect(checkMountRootGuard(cmd, [path('/data/file.txt')], reg, [])).toBeNull()
    }
  })

  it('rm -r on a mount root is refused, never treated as an unmount', () => {
    // The deleted tryUnmountIntercept used to sit behind this guard and
    // would have unmounted instead; GNU (and Python) refuse with EBUSY.
    const result = checkMountRootGuard('rm', [path('/data')], registry(), ['-rf'])
    expect(result?.message).toContain('Device or resource busy')
  })
})
