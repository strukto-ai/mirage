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
import { SpecPolicy, wildcardRegex } from './spec.ts'
import type { CommandContext } from './types.ts'

function path(virtual: string, raw?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: '',
    rawPath: raw ?? virtual,
    resolved: true,
  })
}

function ctx(command: string, paths: PathSpec[]): CommandContext {
  const registry = new MountRegistry({ '/data': new RAMResource() }, MountMode.WRITE, {})
  return { command, paths, argv: [], cwd: '/', registry }
}

describe('wildcardRegex', () => {
  it('star crosses slashes and question is one char', () => {
    expect(wildcardRegex('/data/prod/*').test('/data/prod/a/b/c.txt')).toBe(true)
    expect(wildcardRegex('/data/?.txt').test('/data/a.txt')).toBe(true)
    expect(wildcardRegex('/data/?.txt').test('/data/ab.txt')).toBe(false)
    expect(wildcardRegex('/data/prod/*').test('/data/dev/x')).toBe(false)
  })
})

describe('SpecPolicy', () => {
  it('matches command and path, naming the operand as typed', () => {
    const policy = new SpecPolicy({
      reason: 'prod is protected',
      commands: ['rm', 'mv'],
      paths: ['/data/prod/*'],
    })
    const deny = policy.preCommand(ctx('rm', [path('/data/prod/x.txt', 'prod/x.txt')]))
    expect(deny).toEqual({
      kind: 'deny',
      message: 'rm: prod/x.txt: prod is protected\n',
      exitCode: 1,
    })
    expect(policy.preCommand(ctx('rm', [path('/data/dev/x.txt')]))).toBeNull()
    expect(policy.preCommand(ctx('cat', [path('/data/prod/x.txt')]))).toBeNull()
  })

  it('without paths refuses the command outright', () => {
    const policy = new SpecPolicy({ reason: 'not here', commands: ['shred'] })
    const deny = policy.preCommand(ctx('shred', []))
    expect(deny && 'message' in deny ? deny.message : '').toBe('shred: not here\n')
  })

  it('without commands covers every command', () => {
    const policy = new SpecPolicy({ reason: 'frozen', paths: ['/data/locked/*'] })
    expect(policy.preCommand(ctx('cat', [path('/data/locked/a')]))).not.toBeNull()
    expect(policy.preCommand(ctx('rm', [path('/data/open/a')]))).toBeNull()
  })
})
