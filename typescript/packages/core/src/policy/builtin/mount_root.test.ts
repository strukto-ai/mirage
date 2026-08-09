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

import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { MountRegistry } from '../../workspace/mount/registry.ts'
import { MountRootPolicy, hasParentsFlag } from './mount_root.ts'
import type { CommandContext } from '../types.ts'

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
  operands?: PathSpec[],
): CommandContext {
  return { command, paths, operands: operands ?? paths, argv, cwd: '/', registry: reg }
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

  it('ln wording follows the link kind', () => {
    // GNU words the refusal by link kind: ln -s says "symbolic link",
    // plain ln says "link" (pinned by integ guard_root_ln_is_eexist).
    const policy = new MountRootPolicy()
    const symbolic = policy.preCommand(ctx('ln', [path('/data/k.txt'), path('/data')], ['-s']))
    expect(symbolic && 'message' in symbolic ? symbolic.message : '').toBe(
      "ln: failed to create symbolic link '/data': File exists\n",
    )
    const hard = policy.preCommand(ctx('ln', [path('/data/k.txt'), path('/data')]))
    expect(hard && 'message' in hard ? hard.message : '').toBe(
      "ln: failed to create link '/data': File exists\n",
    )
  })

  it('hasParentsFlag spots the shorthand cluster', () => {
    expect(hasParentsFlag(['-p'])).toBe(true)
    expect(hasParentsFlag(['--parents'])).toBe(true)
    expect(hasParentsFlag(['-pv'])).toBe(true)
    expect(hasParentsFlag(['--print'])).toBe(false)
    expect(hasParentsFlag(['x', '-r'])).toBe(false)
  })
})

describe('MountRootPolicy: whole-mount archivers', () => {
  it.each([
    ['tar', 'tar: /data: Cannot open: Device or resource busy'],
    ['zip', "zip: cannot read '/data': Device or resource busy"],
    ['cp', "cp: cannot copy '/data': Device or resource busy"],
  ])('refuses %s with a mount root in a source slot', (cmd, needle) => {
    // zip's first operand is the archive it writes, cp's last is the
    // destination, so each line puts the mount root in a source slot.
    const operands: Record<string, PathSpec[]> = {
      tar: [path('/data')],
      zip: [path('/out.zip'), path('/data')],
      cp: [path('/data'), path('/dst')],
    }
    const argv = cmd === 'tar' ? ['-cf', '/out.tar'] : []
    const deny = new MountRootPolicy().preCommand(ctx(cmd, operands[cmd] ?? [], argv))
    expect(deny).not.toBeNull()
    expect(deny && 'message' in deny ? deny.message : '').toContain(needle)
  })

  it("names tar's operand as typed and exits 2", () => {
    const deny = new MountRootPolicy().preCommand(
      ctx('tar', [path('/data', '.')], ['-cf', '/out.tar']),
    )
    expect(deny && 'message' in deny ? deny.message : '').toContain('tar: .: Cannot open')
    expect(deny && 'message' in deny ? deny.message : '').toContain('Error is not recoverable')
    expect(deny && 'exitCode' in deny ? deny.exitCode : 0).toBe(2)
  })

  it.each([
    [['-cf', '/a.tar'], true],
    [['--create', '-f', '/a.tar'], true],
    [['cf', '/a.tar'], true],
    [['-tf', '/a.tar'], false],
    [['-xf', '/a.tar'], false],
    [['xzf', '/a.tar'], false],
    [['-xf', '/a.tar', '-C', '/cache'], false],
  ])('only tar create reads its operands from the filesystem: %s', (argv, denied) => {
    // Under -t and -x an operand names a member, not a path, so a
    // selector spelling a mount root must not deny the listing.
    const deny = new MountRootPolicy().preCommand(ctx('tar', [path('/data')], argv))
    expect(deny !== null).toBe(denied)
  })

  it('allows extracting into a mount root', () => {
    // `-C /data` is a path-valued flag, so it reaches paths but never
    // operands; refusing it would block the safe direction.
    const deny = new MountRootPolicy().preCommand(
      ctx('tar', [path('/archive.tar'), path('/data')], [], registry(), [path('/archive.tar')]),
    )
    expect(deny).toBeNull()
  })

  it('allows copying into a mount root', () => {
    const deny = new MountRootPolicy().preCommand(ctx('cp', [path('/src/a.txt'), path('/data')]))
    expect(deny).toBeNull()
  })

  it("does not read zip's archive slot as a source", () => {
    const deny = new MountRootPolicy().preCommand(ctx('zip', [path('/data'), path('/src/a.txt')]))
    expect(deny).toBeNull()
  })
})
