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

import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode, PathSpec } from '../types.ts'
import { MountRegistry } from '../workspace/mount/registry.ts'
import { MountRootPolicy, hasParentsFlag } from './mount_root.ts'
import type { CommandContext } from './types.ts'

function registry(): MountRegistry {
  return new MountRegistry({ '/data': new RAMResource() }, MountMode.WRITE, {})
}

function path(virtual: string, raw?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: '',
    rawPath: raw ?? virtual,
    resolved: true,
  })
}

function ctx(
  command: string,
  paths: PathSpec[],
  argv: string[] = [],
  reg: MountRegistry = registry(),
): CommandContext {
  return { command, paths, argv, cwd: '/', registry: reg }
}

describe('MountRootPolicy', () => {
  it.each([
    ['rm', 'Device or resource busy'],
    ['rmdir', 'Device or resource busy'],
    ['mv', 'Device or resource busy'],
    ['mkdir', 'File exists'],
    ['touch', 'Is a directory'],
    ['ln', 'File exists'],
  ])('refuses %s on a mount root', (cmd, needle) => {
    const deny = new MountRootPolicy().preCommand(ctx(cmd, [path('/data')]))
    expect(deny).not.toBeNull()
    expect(deny?.kind).toBe('deny')
    expect(deny && 'message' in deny ? deny.message : '').toContain(needle)
    expect(deny && 'exitCode' in deny ? deny.exitCode : 0).toBe(1)
  })

  it('treats mkdir -p on a mount root as a no-op', () => {
    const reg = registry()
    const policy = new MountRootPolicy()
    for (const argv of [['-p'], ['--parents'], ['-pv']]) {
      expect(policy.preCommand(ctx('mkdir', [path('/data')], argv, reg))).toBeNull()
    }
    // A long flag containing p is not the shorthand cluster.
    expect(policy.preCommand(ctx('mkdir', [path('/data')], ['--print'], reg))).not.toBeNull()
  })

  it('passes non-root paths and no paths', () => {
    const reg = registry()
    const policy = new MountRootPolicy()
    for (const cmd of ['rm', 'rmdir', 'mv', 'mkdir', 'touch', 'ln']) {
      expect(policy.preCommand(ctx(cmd, [path('/data/file.txt')], [], reg))).toBeNull()
    }
    expect(policy.preCommand(ctx('rm', [], ['-r'], reg))).toBeNull()
  })

  it('rm -r on a mount root is refused, never treated as an unmount', () => {
    const deny = new MountRootPolicy().preCommand(ctx('rm', [path('/data')], ['-rf']))
    expect(deny && 'message' in deny ? deny.message : '').toContain('Device or resource busy')
  })

  it('hasParentsFlag spots the shorthand cluster', () => {
    expect(hasParentsFlag(['-p'])).toBe(true)
    expect(hasParentsFlag(['--parents'])).toBe(true)
    expect(hasParentsFlag(['-pv'])).toBe(true)
    expect(hasParentsFlag(['--print'])).toBe(false)
    expect(hasParentsFlag(['x', '-r'])).toBe(false)
  })
})
