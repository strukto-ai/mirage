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

import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { MountRegistry } from '../../workspace/mount/registry.ts'
import { MountRootPolicy, hasParentsFlag, lnFlagPresent } from './mount_root.ts'
import { decisionOf, renderDeny } from '../policies.ts'
import { CommandWord, type CommandContext, type Deny } from '../types.ts'
import { WordKind } from '../../commands/spec/types.ts'

function registry(): MountRegistry {
  return new MountRegistry({ '/data': new RAMVFS() }, MountMode.WRITE, {})
}

function path(virtual: string, raw?: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: '',
    rawPath: raw ?? virtual,
    resolved: true,
  })
}

function ctx(
  command: string,
  paths: PathSpec[],
  argv: string[] = [],
  operands?: PathSpec[],
): CommandContext {
  const words = [
    new CommandWord(command, WordKind.NAME),
    ...(operands ?? paths).map((p) => new CommandWord(p.rawPath, WordKind.OPERAND, null, p)),
  ]
  return { command, paths, words, argv, cwd: '/' }
}

describe('MountRootPolicy', () => {
  it.each([
    ['rm', 'Is a directory'],
    ['rmdir', 'Device or resource busy'],
    ['mv', 'Device or resource busy'],
    ['mkdir', 'File exists'],
    ['touch', 'Is a directory'],
    ['ln', 'File exists'],
  ])('refuses %s on a mount root', (cmd, needle) => {
    // ln refuses a mount root only as the link NAME, which -T pins;
    // without it a directory operand is the directory to link into.
    const argv = cmd === 'ln' ? ['-T'] : []
    const deny = new MountRootPolicy(registry()).preCommand(ctx(cmd, [path('/data')], argv))
    expect(deny).not.toBeNull()
    expect(deny?.kind).toBe('deny')
    expect(deny && 'reason' in deny ? deny.reason : '').toContain(needle)
    // Every mount-root refusal is the filesystem's own error, in the
    // command's own voice: the command plane renders `<cmd>: <reason>`,
    // and no policy refusal is recorded.
    expect((deny as Deny).error).toBeDefined()
    const [err, code] = renderDeny(cmd, deny as Deny)
    expect(new TextDecoder().decode(err)).toBe(`${cmd}: ${(deny as Deny).reason}\n`)
    expect(code).toBe(1)
    expect(decisionOf(deny as Deny)).toBeNull()
  })

  it('treats mkdir -p on a mount root as a no-op', () => {
    const policy = new MountRootPolicy(registry())
    for (const argv of [['-p'], ['--parents'], ['-pv']]) {
      expect(policy.preCommand(ctx('mkdir', [path('/data')], argv))).toBeNull()
    }
    // A long flag containing p is not the shorthand cluster.
    expect(policy.preCommand(ctx('mkdir', [path('/data')], ['--print']))).not.toBeNull()
  })

  it('passes non-root paths and no paths', () => {
    const policy = new MountRootPolicy(registry())
    for (const cmd of ['rm', 'rmdir', 'mv', 'mkdir', 'touch', 'ln']) {
      expect(policy.preCommand(ctx(cmd, [path('/data/file.txt')], []))).toBeNull()
    }
    expect(policy.preCommand(ctx('rm', [], ['-r']))).toBeNull()
  })

  it.each([
    [
      ['-r'],
      '/data/x/..',
      '/data',
      "refusing to remove '.' or '..' directory: skipping '/data/x/..'",
    ],
    [
      ['-r'],
      '//',
      '//',
      "it is dangerous to operate recursively on '//' (same as '/')\n" +
        'rm: use --no-preserve-root to override this failsafe',
    ],
    [['-r', '--no-pres'], '/', '/', "cannot remove '/': Device or resource busy"],
  ])('rm %j refuses %s in GNU order', (argv, raw, virtual, reason) => {
    const reg = new MountRegistry({ '/': new RAMVFS(), '/data': new RAMVFS() }, MountMode.WRITE, {})
    const deny = new MountRootPolicy(reg).preCommand(ctx('rm', [path(virtual, raw)], argv))
    expect(deny && 'reason' in deny ? deny.reason : '').toBe(reason)
  })

  it('rm -r on a mount root is refused, never treated as an unmount', () => {
    const deny = new MountRootPolicy(registry()).preCommand(ctx('rm', [path('/data')], ['-rf']))
    expect(deny && 'reason' in deny ? deny.reason : '').toContain('Device or resource busy')
  })

  it('ln wording follows the link kind', () => {
    // GNU words the refusal by link kind: ln -s says "symbolic link",
    // plain ln says "link" (pinned by integ guard_root_ln_is_eexist). A
    // mount root is only refused as the link NAME, which -T pins; without
    // it a directory operand is the directory to link into.
    const policy = new MountRootPolicy(registry())
    const symbolic = policy.preCommand(ctx('ln', [path('/data/k.txt'), path('/data')], ['-sT']))
    expect(symbolic && 'reason' in symbolic ? symbolic.reason : '').toBe(
      "failed to create symbolic link '/data': File exists",
    )
    const hard = policy.preCommand(ctx('ln', [path('/data/k.txt'), path('/data')], ['-T']))
    expect(hard && 'reason' in hard ? hard.reason : '').toBe(
      "failed to create link '/data': File exists",
    )
  })

  it('the ln flag scan honors option boundaries', () => {
    const noTarget = (argv: string[]) => lnFlagPresent(argv, 'T', '--no-target-directory')
    const symbolic = (argv: string[]) => lnFlagPresent(argv, 's', '--symbolic')
    expect(noTarget(['-sT', 'a', 'b'])).toBe(true)
    expect(noTarget(['-s', '--no-target-directory', 'a', 'b'])).toBe(true)
    expect(noTarget(['-s', '--', '-T', '/mnt'])).toBe(false)
    expect(noTarget(['-SfooT', 'a', 'b'])).toBe(false)
    expect(noTarget(['-S', 'T', 'a', 'b'])).toBe(false)
    expect(noTarget(['--suffix', 'T', 'a', 'b'])).toBe(false)
    expect(noTarget(['-t', 'T', 'a'])).toBe(false)
    expect(symbolic(['-bs', 'a', 'b'])).toBe(true)
    expect(symbolic(['-S', 's', 'a', 'b'])).toBe(false)
    expect(symbolic(['--', '-s', 'b'])).toBe(false)
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
    [
      'tar',
      'tar: /data: Cannot open: Device or resource busy\n' +
        'tar: Error is not recoverable: exiting now\n',
    ],
    ['zip', "zip: cannot read '/data': Device or resource busy\n"],
    ['cp', "cp: cannot copy '/data': Device or resource busy\n"],
  ])('refuses %s with a mount root in a source slot', (cmd, needle) => {
    // zip's first operand is the archive it writes, cp's last is the
    // destination, so each line puts the mount root in a source slot.
    const operands: Record<string, PathSpec[]> = {
      tar: [path('/data')],
      zip: [path('/out.zip'), path('/data')],
      cp: [path('/data'), path('/dst')],
    }
    const argv = cmd === 'tar' ? ['-cf', '/out.tar'] : []
    const deny = new MountRootPolicy(registry()).preCommand(ctx(cmd, operands[cmd] ?? [], argv))
    expect(deny).not.toBeNull()
    expect(new TextDecoder().decode(renderDeny(cmd, deny as Deny)[0])).toBe(needle)
  })

  it("names tar's operand as typed and exits 2", () => {
    const deny = new MountRootPolicy(registry()).preCommand(
      ctx('tar', [path('/data', '.')], ['-cf', '/out.tar']),
    )
    const [err, code] = renderDeny('tar', deny as Deny)
    expect(new TextDecoder().decode(err)).toContain('tar: .: Cannot open')
    expect(new TextDecoder().decode(err)).toContain('Error is not recoverable')
    // tar's fatal-error code, from the operand-exit table, not from
    // the policy: a Deny carries no number.
    expect(code).toBe(2)
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
    const deny = new MountRootPolicy(registry()).preCommand(ctx('tar', [path('/data')], argv))
    expect(deny !== null).toBe(denied)
  })

  it('allows extracting into a mount root', () => {
    // `-C /data` is a path-valued flag, so it reaches paths but never
    // operands; refusing it would block the safe direction.
    const deny = new MountRootPolicy(registry()).preCommand(
      ctx('tar', [path('/archive.tar'), path('/data')], [], [path('/archive.tar')]),
    )
    expect(deny).toBeNull()
  })

  it('allows copying into a mount root', () => {
    const deny = new MountRootPolicy(registry()).preCommand(
      ctx('cp', [path('/src/a.txt'), path('/data')]),
    )
    expect(deny).toBeNull()
  })

  it("does not read zip's archive slot as a source", () => {
    const deny = new MountRootPolicy(registry()).preCommand(
      ctx('zip', [path('/data'), path('/src/a.txt')]),
    )
    expect(deny).toBeNull()
  })
})
