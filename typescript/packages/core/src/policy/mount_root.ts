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

import type { Policy } from './base.ts'
import type { Action, CommandContext, Deny } from './types.ts'

/**
 * Spot ln's -s/--symbolic by raw token scan. Same reason as
 * hasParentsFlag: the policy fires before flag parsing, and GNU words
 * the refusal by link kind ("failed to create symbolic link" vs
 * "failed to create link").
 */
export function hasSymlinkFlag(argv: readonly string[]): boolean {
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

function deny(message: string): Deny {
  return { kind: 'deny', message, exitCode: 1 }
}

/**
 * The built-in POSIX rule: a mount root is busy, not a directory.
 * Mirrors the kernel's refusal to unlink or replace a mountpoint
 * (EBUSY on Linux), with each command's own GNU message. Fires before
 * mount resolution and cross-mount routing so the refusal is the same
 * however the operands span mounts, and before runtime placement so a
 * routed command is refused identically. MountRegistry seeds it as the
 * first policy (mount-root semantics belong to the mount layer), so
 * its exact GNU messages win over user policies by order, not by
 * privilege.
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

    return null
  }
}
