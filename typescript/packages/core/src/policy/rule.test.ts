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

import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../types.ts'
import { MountRegistry } from '../workspace/mount/registry.ts'
import { RulePolicy } from './rule.ts'
import type { OpsContext } from './types.ts'
import type { CommandContext } from './types.ts'

function path(virtual: string, raw?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: '',
    rawPath: raw ?? virtual,
    resolved: true,
  })
}

function ctx(command: string, paths: PathSpec[]): CommandContext {
  const registry = new MountRegistry({ '/data': new RAMVFS() }, MountMode.WRITE, {})
  return { command, paths, argv: [], cwd: '/', registry }
}

describe('RulePolicy grammar', () => {
  it('a plain path denies the whole subtree and nothing beside it', () => {
    // The document's one grammar: a plain entry is an exact path and its
    // subtree, so `/data/prod` covers `/data/prod/x` but not
    // `/data/production`; the old `*`/`?`-only dialect needed
    // `/data/prod/*` and then missed the directory itself.
    const policy = new RulePolicy({ reason: 'prod', commands: ['rm'], paths: ['/data/prod'] })
    expect(policy.preCommand(ctx('rm', [path('/data/prod')]))).not.toBeNull()
    expect(policy.preCommand(ctx('rm', [path('/data/prod/x')]))).not.toBeNull()
    expect(policy.preCommand(ctx('rm', [path('/data/production')]))).toBeNull()
  })

  it('a slashless glob matches any name component', () => {
    const policy = new RulePolicy({ reason: 'keys', paths: ['*.key'] })
    expect(policy.preCommand(ctx('cat', [path('/a/b.key/c')]))).toEqual({
      kind: 'deny',
      reason: '/a/b.key/c: keys',
      scope: 'operand',
    })
    expect(policy.preCommand(ctx('cat', [path('/a/b.keyx')]))).toBeNull()
    const op: OpsContext = { op: 'read', path: path('/x/y.key'), write: false, prefix: '/x/' }
    expect(policy.preOps(op)).toEqual({ kind: 'deny', reason: 'keys' })
  })

  it('question mark and a class are patterns too', () => {
    const one = new RulePolicy({ reason: 'one', paths: ['/data/?.txt'] })
    expect(one.preCommand(ctx('cat', [path('/data/a.txt')]))).not.toBeNull()
    expect(one.preCommand(ctx('cat', [path('/data/ab.txt')]))).toBeNull()
    const classed = new RulePolicy({ reason: 'cls', paths: ['/data/[ab].txt'] })
    expect(classed.preCommand(ctx('cat', [path('/data/b.txt')]))).not.toBeNull()
    expect(classed.preCommand(ctx('cat', [path('/data/c.txt')]))).toBeNull()
  })
})

describe('RulePolicy', () => {
  it('matches command and path, naming the operand as typed', () => {
    const policy = new RulePolicy({
      reason: 'prod is protected',
      commands: ['rm', 'mv'],
      paths: ['/data/prod/*'],
    })
    const deny = policy.preCommand(ctx('rm', [path('/data/prod/x.txt', 'prod/x.txt')]))
    expect(deny).toEqual({
      kind: 'deny',
      reason: 'prod/x.txt: prod is protected',
      scope: 'operand',
    })
    expect(policy.preCommand(ctx('rm', [path('/data/dev/x.txt')]))).toBeNull()
    expect(policy.preCommand(ctx('cat', [path('/data/prod/x.txt')]))).toBeNull()
  })

  it('without paths refuses the command outright', () => {
    const policy = new RulePolicy({ reason: 'not here', commands: ['shred'] })
    const deny = policy.preCommand(ctx('shred', []))
    expect(deny).toEqual({ kind: 'deny', reason: 'not here' })
  })

  it('without commands covers every command', () => {
    const policy = new RulePolicy({ reason: 'frozen', paths: ['/data/locked/*'] })
    expect(policy.preCommand(ctx('cat', [path('/data/locked/a')]))).not.toBeNull()
    expect(policy.preCommand(ctx('rm', [path('/data/open/a')]))).toBeNull()
  })
})

describe('RulePolicy preOps twin', () => {
  function opsCtx(virtual: string): OpsContext {
    return { op: 'read', path: path(virtual), write: false, prefix: '/data/' }
  }

  it('holds for path-only rules', () => {
    // Pure path protection also fires at the op door, so FUSE and
    // programmatic ops cannot bypass it.
    const policy = new RulePolicy({ reason: 'frozen', paths: ['/data/locked/*'] })
    const deny = policy.preOps(opsCtx('/data/locked/a'))
    expect(deny).toEqual({ kind: 'deny', reason: 'frozen' })
    expect(policy.preOps(opsCtx('/data/open/a'))).toBeNull()
  })

  it('skips command-scoped rules', () => {
    // An op does not know which command issued it; command-scoped
    // rules stay at the command layer.
    const policy = new RulePolicy({
      reason: 'no rm',
      commands: ['rm'],
      paths: ['/data/prod/*'],
    })
    expect(policy.preOps(opsCtx('/data/prod/x'))).toBeNull()
  })
})
