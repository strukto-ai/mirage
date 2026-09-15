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

import { FlagView, SPECS, parseCommand } from '../../../../commands/spec/index.ts'
import { parseToKwargs } from '../../../../commands/spec/parser.ts'
import type { FileStat } from '../../../../types.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import { blamedPath, fsStrerror, isEacces, isEnoent, isErofs } from '../../../../utils/errors.ts'
import { CycleError, gnuBasename } from '../../../../utils/path.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import { fail, ok, readOnlyError, splitFlags } from '../shared.ts'
import { statOrNull } from './probe.ts'
import type { Result } from '../types.ts'

export function posixRelative(target: string, startDir: string): string {
  const t = target.split('/').filter(Boolean)
  const s = startDir.split('/').filter(Boolean)
  let i = 0
  while (i < t.length && i < s.length && t[i] === s[i]) i += 1
  const parts = [...s.slice(i).map(() => '..'), ...t.slice(i)]
  return parts.length > 0 ? parts.join('/') : '.'
}

export function linkFlags(args: (string | PathSpec)[], known: string): Set<string> {
  return splitFlags(args, known)[0]
}

// Resolve every component of a path but the last one. POSIX resolves a
// path one component at a time, and only the last one is exempt for an
// lstat-style command: `stat dlink/f2` reports f2 because dlink was
// resolved on the way to it, while `stat dlink` reports the link. A
// no-follow command therefore still needs its operand's prefix
// resolved. Throws CycleError on ELOOP.
function followParent(namespace: Namespace, virtual: string): string {
  const trimmed = rstripSlash(virtual)
  const cut = trimmed.lastIndexOf('/')
  const name = trimmed.slice(cut + 1)
  if (name === '') return virtual
  const resolved = namespace.follow(trimmed.slice(0, cut) || '/')
  return `${rstripSlash(resolved)}/${name}`
}

// Rewrite path operands through the symlink table (open(2) semantics).
// The directory prefix always resolves; `followLast` decides the final
// component, which is the whole difference between open(2) and lstat(2).
// A trailing slash overrides it per operand, because POSIX reads
// `dlink/` as `dlink/.` and there is no `.` to reach without resolving
// the link first (GNU: `stat dlink` is a symbolic link, `stat dlink/` is
// a directory). `slashFollows` turns that override off, which only tar
// wants: it strips the slash before it stats.
// A rewritten spec keeps the user-typed form in `rawPath` so error messages
// still name the operand as typed; the mount re-stamps `resourcePath` at
// dispatch. Throws CycleError (carrying the typed operand) on ELOOP.
export function followPaths(
  namespace: Namespace,
  items: (string | PathSpec)[],
  followLast = true,
  slashFollows = true,
): (string | PathSpec)[] {
  const out: (string | PathSpec)[] = []
  for (const item of items) {
    if (!(item instanceof PathSpec)) {
      out.push(item)
      continue
    }
    const last = followLast || (slashFollows && item.rawPath.endsWith('/'))
    let virtual: string
    try {
      virtual = last ? namespace.follow(item.virtual) : followParent(namespace, item.virtual)
    } catch (err) {
      if (err instanceof CycleError) throw new CycleError(item.rawPath)
      throw err
    }
    if (virtual === item.virtual) {
      out.push(item)
      continue
    }
    out.push(
      new PathSpec({
        virtual,
        directory: virtual.slice(0, virtual.lastIndexOf('/') + 1) || '/',
        resourcePath: '',
        pattern: item.pattern,
        resolved: item.resolved,
        rawPath: item.rawPath,
      }),
    )
  }
  return out
}

// Whether the command layer will act on this line as written.
//
// A link entry lives in the namespace, so `stripLinkOperands` removes it
// before the command runs, and the command layer can neither see that nor
// undo it. GNU validates the whole line first and removes nothing when it
// refuses: `rm --bogus dlink` reports the option and `unlink dlink other`
// reports the extra operand, both with every link still in place. So the
// strip runs only for a line that layer accepts, and a refused one falls
// through to it unchanged to be reported there. Option errors are the
// parser's, which reports rather than raises them; unlink's one-operand
// grammar is its builder's, and reporting it needs the operands to arrive
// intact.
export function acceptsLine(
  name: string,
  args: readonly string[],
  items: (string | PathSpec)[],
  cwd: string,
): boolean {
  const spec = SPECS[name]
  if (spec === undefined) return true
  const parsed = parseCommand(spec, [...args], cwd)
  if (parsed.invalidOptions.length > 0 || parsed.ambiguousOptions.length > 0) {
    return false
  }
  if (name === 'unlink') {
    return items.filter((i) => i instanceof PathSpec).length <= 1
  }
  return true
}

// Unlink and drop `rm`/`unlink` operands that are symlinks. GNU rm removes
// the link itself and never follows it; a dangling link removes fine.
//
// The removal is a dispatch op, never a direct table write: the door is
// where session grants, the turf's mode, admission policies and the op
// ledger fire, and writing the table from here let a session delete a
// link its grant reads and a policy protecting one never fired (the same
// hole the FUSE unlink had). A refused operand does not stop the rest,
// which is also rm's rule for a backend operand; `-f` silences only the
// absent (a hidden link answers ENOENT, the no-name-leak rule).
//
// The refusal is voiced the way the same refusal on a backend file is
// voiced, so one grant does not describe itself two ways: a mount-mode
// refusal renders readOnlyError (naming the mount, deduplicated because
// two operands on one mount are one fact), everything else renders GNU's
// per-operand line.
//
// An operand typed with a trailing slash is deliberately kept: the slash
// asked for a directory, and GNU refuses rather than removing the link
// (`rm dlink/` is "Is a directory", `unlink dlink/` is "Not a
// directory"). Removing it here would delete exactly what the slash was
// protecting, so the command reports it instead. Returns the surviving
// parts, the number of link operands consumed (removed, refused or
// force-silenced), and the refusal lines. Mirrors Python's
// strip_link_operands.
export async function stripLinkOperands(
  name: string,
  dispatch: DispatchFn,
  namespace: Namespace,
  items: (string | PathSpec)[],
  args: readonly string[],
  cwd: string,
): Promise<[(string | PathSpec)[], number, string[]]> {
  let force = false
  if (name === 'rm') {
    const spec = SPECS.rm
    if (spec !== undefined) {
      // Keyed by the dashed spelling the line used, not the dest.
      force = parseCommand(spec, [...args], cwd).flags['-f'] === true
    }
  }
  const verb = name === 'rm' ? 'remove' : 'unlink'
  let handled = 0
  const errors: string[] = []
  const kept: (string | PathSpec)[] = []
  for (const item of items) {
    if (item instanceof PathSpec && !item.rawPath.endsWith('/') && namespace.isLink(item.virtual)) {
      handled += 1
      try {
        await dispatch('unlink', item)
      } catch (err) {
        const suffix = fsStrerror(err)
        if (suffix === null) throw err
        if (isEnoent(err) && force) continue
        if (isErofs(err)) {
          // The mount voice, because the mount is what refused: a
          // backend file on this operand's turf is answered by
          // Mount.executeCmd with this exact line, and one grant must
          // not describe itself two ways depending on whether the name
          // it stopped was a link.
          const line = readOnlyError(name, namespace, item)
          if (!errors.includes(line)) errors.push(line)
          continue
        }
        errors.push(`${name}: cannot ${verb} '${item.rawPath}': ${suffix}\n`)
      }
      continue
    }
    kept.push(item)
  }
  return [kept, handled, errors]
}

// GNU's refusal for an `mv` source that is a link typed with a slash.
//
// rename(2) never follows, so the slash is not resolved away: POSIX reads
// `dlink/` as `dlink/.`, which asks for a directory the call will not
// resolve, and GNU refuses with everything left in place -- where a bare
// `dlink` renames the link entry. Which of the four wordings applies
// follows mv's own order, source stat before destination type before the
// rename itself, and all four are pinned against GNU coreutils 9.7.
async function slashedLinkRefusal(
  namespace: Namespace,
  dispatch: DispatchFn,
  src: PathSpec,
  dst: PathSpec,
  dstStat: FileStat | null,
): Promise<Result> {
  const followed = namespace.follow(src.virtual)
  const target = await statOrNull(dispatch, PathSpec.fromStrPath(followed))
  if (target === null) {
    return fail('mv', `mv: cannot stat '${src.rawPath}': No such file or directory\n`)
  }
  if (target.type !== FileType.DIRECTORY) {
    return fail('mv', `mv: cannot stat '${src.rawPath}': Not a directory\n`)
  }
  if (dstStat !== null && dstStat.type !== FileType.DIRECTORY) {
    return fail(
      'mv',
      `mv: cannot overwrite non-directory '${dst.rawPath}' with directory '${src.rawPath}'\n`,
    )
  }
  let landing = dst.rawPath
  if (dstStat !== null) {
    landing = rstripSlash(landing) + '/' + gnuBasename(src.virtual)
  }
  return fail('mv', `mv: cannot move '${src.rawPath}' to '${landing}': Not a directory\n`)
}

export interface PreparedMv {
  items: (string | PathSpec)[]
  postUnlink: string | null
  postRename: [string, string] | null
  early: Result | null
}

// Adjust a two-operand `mv` for node-meta operands. A link source renames
// the link entry itself. A destination that is (a link to) a directory
// receives the move inside it (rename(2) preceded by mv's dst stat); any
// other destination is replaced, so its node entry, link or overlay attrs
// alike, drops once the backend move succeeds. A plain source hands back the
// pair to re-anchor once the backend move succeeds, so whatever the node table
// holds at it and below it travels with the bytes.
//
// The pair is where this can be done at all: a single-mount `mv` renames
// through the backend op bound to the accessor rather than through the
// dispatcher, so the re-anchoring the dispatcher does for every other caller
// has to be repeated here. Only a two-operand line qualifies, because a
// path-shaped word is classified into a PathSpec whether it filled an operand
// slot or a flag's value, and nothing here can tell `mv a b dst` from
// `mv -t dst a b`.
export async function prepareMv(
  namespace: Namespace,
  dispatch: DispatchFn,
  items: (string | PathSpec)[],
  args: readonly string[],
  cwd: string,
): Promise<PreparedMv> {
  const paths = items.filter((p): p is PathSpec => p instanceof PathSpec)
  const src = paths[0]
  const dst = paths[1]
  if (paths.length !== 2 || src === undefined || dst === undefined) {
    return { items, postUnlink: null, postRename: null, early: null }
  }
  // `-t` makes every positional a source and the flag's value the destination,
  // which is the many-source shape above; `-T` names the destination outright,
  // so no basename is appended to it. Both are read off the parsed line rather
  // than guessed from the parts, since a path-shaped flag value is classified
  // into a PathSpec there exactly as an operand is.
  const spec = SPECS.mv
  if (spec === undefined) return { items, postUnlink: null, postRename: null, early: null }
  const fl = new FlagView(parseToKwargs(parseCommand(spec, [...args], cwd)), spec)
  if (fl.raw('target_directory') !== undefined) {
    return { items, postUnlink: null, postRename: null, early: null }
  }

  // Where the move lands: inside a directory destination (followed, so
  // node-meta keys line up with the followed paths stat merges on), else
  // the destination itself, replaced like rename(2).
  const followed = namespace.follow(dst.virtual)
  const stat = await statOrNull(dispatch, PathSpec.fromStrPath(followed))
  const intoDir =
    !fl.asBool('no_target_directory') && stat !== null && stat.type === FileType.DIRECTORY
  let targetDst = dst.virtual
  if (intoDir) {
    const name = src.virtual.slice(src.virtual.lastIndexOf('/') + 1)
    targetDst = rstripSlash(followed) + '/' + name
  }

  if (namespace.isLink(src.virtual)) {
    if (src.rawPath.endsWith('/')) {
      const early = await slashedLinkRefusal(namespace, dispatch, src, dst, stat)
      return { items, postUnlink: null, postRename: null, early }
    }
    // The move is a node-table rename, which the door answers: a link
    // has no backend entry for the generic mv to move. Reaching the
    // table directly from here would skip the admission gates every
    // other mv passes, so the dispatch is the point.
    try {
      await dispatch('rename', src, [PathSpec.fromStrPath(targetDst)])
    } catch (err) {
      const suffix = fsStrerror(err)
      if (suffix === null || (!isEacces(err) && !isErofs(err))) throw err
      // Voiced as the same refusal on a backend file is: the mount
      // voice when the source's own turf is what refused (the case
      // Mount.executeCmd answers, since the command runs on the source
      // mount), GNU's per-operand line when it was the destination --
      // which is what a cross-mount `mv f /ro/f` already answers for a
      // regular file. A policy deny is always per operand.
      const blame = isErofs(err) ? (blamedPath(err) ?? src.virtual) : ''
      const early: Result = fail(
        'mv',
        blame === src.virtual
          ? readOnlyError('mv', namespace, src)
          : `mv: cannot move '${src.rawPath}' to '${dst.rawPath}': ${suffix}\n`,
      )
      return { items, postUnlink: null, postRename: null, early }
    }
    const early: Result = ok('mv')
    return { items, postUnlink: null, postRename: null, early }
  }

  // Unconditional: a directory source carries a whole subtree of node entries
  // that no exact-path lookup at the source can see, and a symlink below it is
  // destroyed rather than merely forgotten when they are left behind. Both
  // halves are no-ops when the table holds nothing there.
  const postRename: [string, string] = [src.virtual, targetDst]

  const rewritten = intoDir && namespace.isLink(dst.virtual) ? followPaths(namespace, items) : items
  return { items: rewritten, postUnlink: targetDst, postRename, early: null }
}
