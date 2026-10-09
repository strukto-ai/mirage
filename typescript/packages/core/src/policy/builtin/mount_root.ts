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
import { isCreateMode } from '../../commands/builtin/generic/tar/mode.ts'
import { expandTableLong } from '../../commands/spec/compile.ts'
import { GNU_LONG_OPTIONS } from '../../commands/spec/long_options.ts'
import type { PathSpec } from '../../types.ts'

/**
 * Spot ln's -s/--symbolic by raw token scan. Same reason as
 * hasParentsFlag: the policy fires before flag parsing, and GNU words
 * the refusal by link kind ("failed to create symbolic link" vs
 * "failed to create link").
 */
const LN_VALUED_SHORTS = 'tS'
const LN_VALUED_LONGS: ReadonlySet<string> = new Set(['--target-directory', '--suffix'])

// Whether ln's raw argv carries one short flag or its long spelling. The
// scan is option-aware so an operand cannot pose as a flag: it stops at
// `--`, skips the value of a valued option (`-t DIR`, `-S SUF`, their
// long forms), and inside a cluster stops at the first valued letter,
// whose remainder is its attached value (`-SfooT` carries no -T).
export function lnFlagPresent(argv: readonly string[], letter: string, long: string): boolean {
  let skip = false
  for (const tok of argv) {
    if (skip) {
      skip = false
      continue
    }
    if (tok === '--') return false
    if (tok === long) return true
    if (tok.startsWith('--')) {
      skip = LN_VALUED_LONGS.has(tok)
      continue
    }
    if (!tok.startsWith('-') || tok.length < 2) continue
    for (let pos = 1; pos < tok.length; pos++) {
      const ch = tok[pos]
      if (ch === letter) return true
      if (ch !== undefined && LN_VALUED_SHORTS.includes(ch)) {
        skip = pos === tok.length - 1
        break
      }
    }
  }
  return false
}

function hasNoTargetFlag(argv: readonly string[]): boolean {
  return lnFlagPresent(argv, 'T', '--no-target-directory')
}

function hasSymlinkFlag(argv: readonly string[]): boolean {
  return lnFlagPresent(argv, 's', '--symbolic')
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
 * What an rm line asks of a directory operand, by raw token scan: recurse
 * (-r, -R), remove an empty one (-d), and keep `/` out of a recursive
 * removal, which is the default; the last of --preserve-root and
 * --no-preserve-root wins. A long word is read against rm's whole table, so
 * an abbreviation counts too. Mirrors Python's rm_options.
 */
export function rmOptions(argv: readonly string[]): [boolean, boolean, boolean] {
  let recursive = false
  let emptyDir = false
  let preserve = true
  for (const tok of argv) {
    if (tok === '-') continue
    if (tok === '--') break
    if (tok.startsWith('--')) {
      const name = expandTableLong(GNU_LONG_OPTIONS.rm ?? [], tok.split('=', 1)[0] ?? tok)
      const only = name.length === 1 ? name[0] : undefined
      if (only === '--recursive') recursive = true
      else if (only === '--dir') emptyDir = true
      else if (only === '--preserve-root') preserve = true
      else if (only === '--no-preserve-root') preserve = false
      continue
    }
    if (tok.startsWith('-')) {
      recursive ||= tok.includes('r') || tok.includes('R')
      emptyDir ||= tok.includes('d')
    }
  }
  return [recursive, emptyDir, preserve]
}

// An operand as fts hands it back: two or more trailing slashes trimmed to
// one, so `///` reads `/` while `//` stays.
export function ftsName(raw: string): string {
  let end = raw.length
  if (end > 2 && raw.endsWith('/')) {
    while (end > 1 && raw[end - 2] === '/') end -= 1
  }
  return raw.slice(0, end)
}

/**
 * rm's refusal of a mount root, in GNU rm's order and words: a recursive `.`
 * or `..` is skipped before anything is looked at, a directory without -r or
 * -d is not removed at all, and a recursive `/` meets the root failsafe; only
 * what is left reaches the mountpoint and is busy. Mirrors Python's
 * rm_root_refusal.
 */
export function rmRootRefusal(
  path: PathSpec,
  recursive: boolean,
  emptyDir: boolean,
  preserve: boolean,
): string {
  const raw = path.rawPath
  const last = raw.replace(/\/+$/, '').split('/').at(-1) ?? ''
  if (recursive && (last === '.' || last === '..')) {
    return `refusing to remove '.' or '..' directory: skipping '${raw}'`
  }
  if (!recursive && !emptyDir) return `cannot remove '${raw}': Is a directory`
  if (recursive && preserve && path.virtual.replaceAll('/', '') === '') {
    const shown = ftsName(raw)
    const named = shown === '/' ? "'/'" : `'${shown}' (same as '/')`
    return (
      `it is dangerous to operate recursively on ${named}\n` +
      'rm: use --no-preserve-root to override this failsafe'
    )
  }
  return `cannot remove '${raw}': Device or resource busy`
}

// Every mount-root refusal is about one operand and speaks in the
// command's own voice: the command plane prefixes the command name and picks the
// exit code from the operand table (1, tar 2).
function deny(reason: string): Deny {
  return { kind: 'deny', reason, scope: 'operand' }
}

// The first of these paths that is a mount root, if any.
function firstRoot(
  namesRoot: (path: PathSpec) => boolean,
  paths: readonly PathSpec[],
): PathSpec | null {
  for (const path of paths) {
    if (namesRoot(path)) return path
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
    // An operand the kernel walk refused (`walkError`) names nothing,
    // whatever its `virtual` reads as: the empty name simplifies to the
    // working directory, which can be a mount root, and the command
    // reports it ENOENT rather than busy. Mirrors Python's names_root.
    const namesRoot = (p: PathSpec): boolean =>
      p.walkError === null && ctx.registry.isMountRoot(p.virtual)
    const cmd = ctx.command
    const operands = ctx.operands ?? ctx.paths

    if (cmd === 'rm') {
      const root = firstRoot(namesRoot, ctx.paths)
      if (root === null) return null
      return deny(rmRootRefusal(root, ...rmOptions(ctx.argv)))
    }

    if (cmd === 'rmdir') {
      for (const p of ctx.paths) {
        if (namesRoot(p)) return deny(`failed to remove '${p.virtual}': Device or resource busy`)
      }
      return null
    }

    if (cmd === 'mv') {
      // The source is a slot, so it is read off the positionals:
      // `mv -t /mnt f` moves INTO a mount root, which is ordinary.
      const source = operands[0]
      if (source !== undefined && namesRoot(source)) {
        const dst = ctx.paths[1] !== undefined ? ctx.paths[1].virtual : '?'
        return deny(`cannot move '${source.virtual}' to '${dst}': Device or resource busy`)
      }
      return null
    }

    if (cmd === 'mkdir') {
      // GNU mkdir -p makes "already exists" a no-op.
      if (hasParentsFlag(ctx.argv)) return null
      for (const p of ctx.paths) {
        if (namesRoot(p)) {
          return deny(`cannot create directory '${p.virtual}': File exists`)
        }
      }
      return null
    }

    if (cmd === 'touch') {
      // Positionals only: `-r REF` is read, never touched.
      for (const p of operands) {
        if (namesRoot(p)) {
          return deny(`cannot touch '${p.virtual}': Is a directory`)
        }
      }
      return null
    }

    if (cmd === 'ln') {
      // A mount root is refused only as the link NAME. Without -T a
      // directory operand is the directory to link into, GNU's rule, and
      // creating inside a mount is ordinary.
      const last = ctx.paths[ctx.paths.length - 1]
      if (last !== undefined && hasNoTargetFlag(ctx.argv) && namesRoot(last)) {
        const kind = hasSymlinkFlag(ctx.argv) ? 'symbolic link' : 'link'
        return deny(`failed to create ${kind} '${last.virtual}': File exists`)
      }
      return null
    }

    if (cmd === 'tar') {
      // Only -c reads the filesystem; -t and -x match their operands
      // against names inside the archive.
      const root = isCreateMode(ctx.argv) ? firstRoot(namesRoot, operands) : null
      if (root !== null) {
        return deny(
          `${root.rawPath}: Cannot open: Device or resource busy\n` +
            `tar: Error is not recoverable: exiting now`,
        )
      }
      return null
    }

    if (cmd === 'zip') {
      // The first operand is the archive being written, not a source;
      // only what follows it is read.
      const root = firstRoot(namesRoot, operands.slice(1))
      if (root !== null) {
        return deny(`cannot read '${root.rawPath}': Device or resource busy`)
      }
      return null
    }

    if (cmd === 'cp') {
      // The last operand is the destination, and copying INTO a mount is
      // ordinary; only the sources are refused.
      const root = firstRoot(namesRoot, operands.slice(0, -1))
      if (root !== null) {
        return deny(`cannot copy '${root.rawPath}': Device or resource busy`)
      }
      return null
    }

    return null
  }
}
