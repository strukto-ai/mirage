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

import type { Policy } from '../base.ts'
import type { Action, CommandContext, Deny } from '../types.ts'
import type { PathSpec } from '../../types.ts'

/**
 * Spot ln's -s/--symbolic by raw token scan. Same reason as
 * hasParentsFlag: the policy fires before flag parsing, and GNU words
 * the refusal by link kind ("failed to create symbolic link" vs
 * "failed to create link").
 */
function hasSymlinkFlag(argv: readonly string[]): boolean {
  for (const tok of argv) {
    if (tok === '--symbolic') return true
    if (tok.startsWith('-') && !tok.startsWith('--') && tok.includes('s')) return true
  }
  return false
}

/**
 * Spot mkdir's -p/--parents by raw token scan. The policy fires before
 * flag parsing (its refusals must win over parse errors and stay
 * consistent across the single-mount and cross-mount paths), so the
 * shorthand cluster (-pv) is detected on the raw argv rather than
 * through the spec parser.
 */
export function hasParentsFlag(argv: readonly string[]): boolean {
  for (const tok of argv) {
    if (tok === '-p' || tok === '--parents') return true
    if (tok.startsWith('-') && !tok.startsWith('--') && tok.includes('p')) return true
  }
  return false
}

/**
 * Whether a tar line reads the filesystem rather than an archive.
 *
 * Only `-c` makes tar's operands source paths. Under `-t` and `-x` they are
 * member selectors matched against names inside the archive, so a selector
 * that happens to spell a mount root is not a mount at all and refusing it
 * would deny an ordinary listing.
 *
 * Scanned raw for the same reason hasSymlinkFlag is: the policy fires before
 * flag parsing. Only the first word may be GNU's dashless option cluster
 * (`tar cf a.tar d`), so a later bare word is an operand and cannot turn the
 * mode on.
 */
function isCreateMode(argv: readonly string[]): boolean {
  for (const [i, tok] of argv.entries()) {
    if (tok === '--create') return true
    if (tok.startsWith('--')) continue
    if (tok.startsWith('-')) {
      if (tok.slice(1).includes('c')) return true
      continue
    }
    if (i === 0 && tok.includes('c')) return true
  }
  return false
}

function deny(message: string, exitCode = 1): Deny {
  return { kind: 'deny', message, exitCode }
}

// The first of these paths that is a mount root, if any.
function firstRoot(
  isRoot: (virtual: string) => boolean,
  paths: readonly PathSpec[],
): PathSpec | null {
  for (const path of paths) {
    if (isRoot(path.virtual)) return path
  }
  return null
}

/**
 * The built-in rule: a mount root is not an ordinary directory.
 *
 * Two rules, one boundary. The first mirrors the kernel's refusal to unlink
 * or replace a mountpoint (EBUSY on Linux), with each command's own GNU
 * message: rm, rmdir, mv, mkdir, touch and ln.
 *
 * The second is mirage's own, and is a deliberate divergence: an archiver or
 * a recursive copy pointed at a mount root would read an entire backend into
 * one object. Real tar and cp allow it because a mountpoint there is just
 * another directory; here the mount table is the deployment's configuration,
 * and consuming a whole mount is neither what the operand looks like it costs
 * nor something an agent should be able to do to data it was merely given a
 * view of. The refusal names the boundary in each tool's own voice rather
 * than inventing a mirage error, so a caller sees a filesystem answer.
 *
 * Only positional operands are tested. tar's `-C` and unzip's `-d` are
 * destinations to extract INTO, which is ordinary use of a mount, so reading
 * them here would refuse the safe direction as well.
 *
 * Fires before mount resolution and cross-mount routing so the refusal is the
 * same however the operands span mounts, and before runtime placement so a
 * routed command is refused identically. MountRegistry seeds it as the first
 * policy (mount-root semantics belong to the mount layer), so its exact
 * messages win over user policies by order, not by privilege.
 */
export class MountRootPolicy implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    if (ctx.paths.length === 0) return null
    const isRoot = (virtual: string): boolean => ctx.registry.isMountRoot(virtual)
    const cmd = ctx.command

    if (cmd === 'rm' || cmd === 'rmdir') {
      for (const p of ctx.paths) {
        if (isRoot(p.virtual)) {
          return deny(
            cmd === 'rmdir'
              ? `rmdir: failed to remove '${p.virtual}': Device or resource busy\n`
              : `rm: cannot remove '${p.virtual}': Device or resource busy\n`,
          )
        }
      }
      return null
    }

    if (cmd === 'mv') {
      if (ctx.paths[0] !== undefined && isRoot(ctx.paths[0].virtual)) {
        const dst = ctx.paths[1] !== undefined ? ctx.paths[1].virtual : '?'
        return deny(
          `mv: cannot move '${ctx.paths[0].virtual}' to '${dst}': Device or resource busy\n`,
        )
      }
      return null
    }

    if (cmd === 'mkdir') {
      // GNU mkdir -p makes "already exists" a no-op.
      if (hasParentsFlag(ctx.argv)) return null
      for (const p of ctx.paths) {
        if (isRoot(p.virtual)) {
          return deny(`mkdir: cannot create directory '${p.virtual}': File exists\n`)
        }
      }
      return null
    }

    if (cmd === 'touch') {
      for (const p of ctx.paths) {
        if (isRoot(p.virtual)) {
          return deny(`touch: cannot touch '${p.virtual}': Is a directory\n`)
        }
      }
      return null
    }

    if (cmd === 'ln') {
      const last = ctx.paths[ctx.paths.length - 1]
      if (last !== undefined && isRoot(last.virtual)) {
        const kind = hasSymlinkFlag(ctx.argv) ? 'symbolic link' : 'link'
        return deny(`ln: failed to create ${kind} '${last.virtual}': File exists\n`)
      }
      return null
    }

    const operands = ctx.operands ?? ctx.paths

    if (cmd === 'tar') {
      // Only -c reads the filesystem; -t and -x match their operands
      // against names inside the archive.
      const root = isCreateMode(ctx.argv) ? firstRoot(isRoot, operands) : null
      if (root !== null) {
        return deny(
          `tar: ${root.rawPath}: Cannot open: Device or resource busy\n` +
            `tar: Error is not recoverable: exiting now\n`,
          2,
        )
      }
      return null
    }

    if (cmd === 'zip') {
      // The first operand is the archive being written, not a source;
      // only what follows it is read.
      const root = firstRoot(isRoot, operands.slice(1))
      if (root !== null) {
        return deny(`zip: cannot read '${root.rawPath}': Device or resource busy\n`)
      }
      return null
    }

    if (cmd === 'cp') {
      // The last operand is the destination, and copying INTO a mount is
      // ordinary; only the sources are refused.
      const root = firstRoot(isRoot, operands.slice(0, -1))
      if (root !== null) {
        return deny(`cp: cannot copy '${root.rawPath}': Device or resource busy\n`)
      }
      return null
    }

    return null
  }
}
