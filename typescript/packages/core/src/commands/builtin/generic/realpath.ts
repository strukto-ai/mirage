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
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { missingOperandError } from '../../spec/usage.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { FileStat } from '../../../types.ts'
import { FileType, PathSpec, type StatFn } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { eloop, enoent, enotdir, isMissingPath } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { parent } from '../../../utils/path.ts'
import { dispatchStat, linkTarget } from '../utils/paths.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { linksOf } from '../utils/links.ts'

const MODES: Record<string, string> = { canonicalize_existing: 'e', canonicalize_missing: 'm' }
const LINKS: Record<string, string> = { logical: 'L', physical: 'P', strip: 's', no_symlinks: 's' }
// GNU 9.7 resolves a chain of any length (3,000 links measured) and calls a
// loop of any length a loop; a walk here stops at LINK_LIMIT links, so a
// longer chain is refused as a loop. On a loop, `-m` keeps unresolved the
// first link that comes round again counting from the 21st: of
// l1 -> l2 -> ... -> lk -> l1, measured for k from 1 to 50, `realpath -m l1`
// prints l((20 mod k) + 1), and behind a chain of more than 20 links it
// prints the loop's first link.
const LINK_LIMIT = 1024
const KEPT_FROM = 21

type Step = readonly [string, readonly string[]]

/**
 * The link `-m` leaves unresolved once the walk is back at a link: from
 * `first` on the walk repeats itself every `steps.length - first` links, so
 * the first link met again from the KEPT_FROM-th on is the loop's own first
 * link, or the link that step lands on when fewer links lead into the loop.
 * Mirrors Python's _kept_link.
 */
function keptLink(steps: readonly Step[], first: number): Step {
  const period = steps.length - first
  const landing = Math.max(KEPT_FROM - 1, first)
  const step = steps[first + ((landing - first) % period)]
  if (step === undefined) throw new RangeError(`no step ${String(landing)}`)
  return step
}

/**
 * GNU realpath's options, the last of each family winning: `mode` is `e`
 * (every component must exist), `m` (none has to) or empty (all but the
 * last, the default); `links` is `P` (resolve each link as the walk meets
 * it), `L` (resolve the `..` components first) or `s` (resolve none).
 * Mirrors Python's RealpathFlags.
 */
export interface RealpathFlags {
  mode: string
  links: string
  quiet: boolean
  zero: boolean
  relativeTo: string | null
  relativeBase: string | null
}

export function parseFlags(flags: Context['flags']): RealpathFlags {
  const fl = new FlagView(flags, specOf('realpath'))
  const mode = fl.typedOrder(...Object.keys(MODES)).pop()
  const links = fl.typedOrder(...Object.keys(LINKS)).pop()
  return {
    mode: mode !== undefined ? (MODES[mode] ?? '') : '',
    links: links !== undefined ? (LINKS[links] ?? 'P') : 'P',
    quiet: fl.asBool('quiet'),
    zero: fl.asBool('zero'),
    relativeTo: fl.asStr('relative_to') ?? null,
    relativeBase: fl.asStr('relative_base') ?? null,
  }
}

async function directory(stat: StatFn, path: string, word: string): Promise<void> {
  if ((await stat(PathSpec.fromStrPath(path))).type !== FileType.DIRECTORY) throw enotdir(word)
}

/**
 * A path with its links resolved, the walk `realpath` and `readlink -f`
 * share. A relative word starts at the working directory.
 * Each named component is appended and, unless `nolinks`, a link there is
 * read (`readlink`, one link's target or null) and its target put in front
 * of the names left, so a `..` climbs from where a link leads. A link the
 * session cannot see is no link, as a hidden path is no path: `readlink` is
 * the dispatcher's reader, which answers none for it. A component
 * followed by `.` or `..` must be a directory. A trailing slash rejects an
 * existing non-directory. GNU 9.7's default mode accepts a missing final
 * component with a slash; `nolinks` also accepts missing parents. `e`
 * requires existence, while `m` checks nothing. A walk that comes back to a
 * link with the same names left is in a loop, `Too many levels of symbolic
 * links`, and so is one that meets more than LINK_LIMIT links, which covers
 * a link that grows the names it leaves (`a -> a/x`) and that GNU walks until
 * memory runs out. `m` instead leaves one link unresolved and goes on with
 * the names left after it: on a loop the one keptLink picks, past the limit
 * the link it stopped at. Throws the first check the walk fails. Mirrors
 * Python.
 */
export async function canonicalize(
  word: string,
  cwd: string,
  mode: string,
  nolinks: boolean,
  readlink: ((path: string) => string | null) | null,
  stat: StatFn,
): Promise<string> {
  if (word === '') throw enoent(word)
  const names = (word.startsWith('/') ? word : `${cwd}/${word}`).split('/').filter((n) => n !== '')
  let slash = word.endsWith('/')
  let path = '/'
  let last: string | undefined
  const steps: Step[] = []
  const stepOf = new Map<string, number>()
  for (let name = names.shift(); name !== undefined; name = names.shift()) {
    last = name
    if (name === '.' || name === '..') {
      if (name === '..') path = parent(path)
      continue
    }
    path = path === '/' ? `/${name}` : `${path}/${name}`
    const target = nolinks || readlink === null ? null : readlink(path)
    if (target !== null) {
      const here: Step = [path, [...names]]
      const key = JSON.stringify(here)
      const again = stepOf.get(key)
      if (again === undefined && steps.length < LINK_LIMIT) {
        stepOf.set(key, steps.length)
        steps.push(here)
        slash = slash || (names.length === 0 && target.endsWith('/'))
        names.unshift(...target.split('/').filter((n) => n !== ''))
        path = target.startsWith('/') ? '/' : parent(path)
        continue
      }
      if (mode !== 'm') throw eloop(word)
      if (again !== undefined) {
        const [keptPath, rest] = keptLink(steps, again)
        path = keptPath
        names.splice(0, names.length, ...rest)
        last = path.slice(path.lastIndexOf('/') + 1)
      }
    }
    const next = names[0]
    if (mode !== 'm' && (next === '.' || next === '..')) await directory(stat, path, word)
  }
  if (mode === 'm' || last === undefined || last === '.' || last === '..') return path
  try {
    if (slash) await directory(stat, path, word)
    else await stat(PathSpec.fromStrPath(path))
  } catch (err) {
    if (!isMissingPath(err) || mode === 'e') throw err
    if (!nolinks) await directory(stat, parent(path), word)
  }
  return path
}

function under(base: string, path: string): boolean {
  return base === '/' || path === base || path.startsWith(`${base}/`)
}

function relative(path: string, base: string): string {
  const a = path.split('/').filter((s) => s !== '')
  const b = base.split('/').filter((s) => s !== '')
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  return [...b.slice(common).map(() => '..'), ...a.slice(common)].join('/') || '.'
}

/**
 * Print each operand's canonical path, GNU `realpath` (9.7). An operand
 * that does not resolve is reported and the rest still print, exit 1. A
 * `--relative-to` or `--relative-base` directory resolves the same way
 * first, and one that does not ends the command. Mirrors Python's realpath.
 */
export async function realpath(
  paths: readonly PathSpec[],
  stat: StatFn,
  cwd = '/',
  readlink: ((path: string) => string | null) | null = null,
  flags: RealpathFlags = parseFlags({}),
): Promise<[ByteSource | null, IOResult]> {
  if (paths.length === 0) throw missingOperandError('realpath', null)
  const canon = async (word: string): Promise<string> => {
    const path = await canonicalize(word, cwd, flags.mode, flags.links !== 'P', readlink, stat)
    if (flags.links !== 'L') return path
    return canonicalize(path, cwd, flags.mode, false, readlink, stat)
  }
  const relativeTo = flags.relativeTo ?? flags.relativeBase
  let to: string | null = null
  let base: string | null = null
  for (const word of new Set([relativeTo, flags.relativeBase])) {
    if (word === null) continue
    let path: string
    try {
      path = await canon(word)
      if (flags.mode === 'e') await directory(stat, path, word)
    } catch (err) {
      if (!(err instanceof Error)) throw err
      return [
        null,
        new IOResult({ exitCode: 1, stderr: encodeText(fsErrorLine('realpath', word, err)) }),
      ]
    }
    if (word === relativeTo) [to, base] = [path, word === flags.relativeBase ? path : null]
    else if (under(path, to ?? '/')) base = path
    else [to, base] = [null, to]
  }
  const lines: string[] = []
  const errors: string[] = []
  let failed = false
  for (const p of paths) {
    let path: string
    try {
      path = await canon(p.rawPath)
    } catch (err) {
      if (!(err instanceof Error)) throw err
      failed = true
      if (!flags.quiet) errors.push(fsErrorLine('realpath', p, err))
      continue
    }
    const shown = to === null || (base !== null && !under(base, path))
    lines.push(shown ? path : relative(path, to ?? '/'))
  }
  const end = flags.zero ? '\0' : '\n'
  const out: ByteSource | null =
    lines.length > 0 ? encodeText(lines.map((l) => l + end).join('')) : null
  const stderr = errors.length > 0 ? encodeText(errors.join('')) : null
  return [out, new IOResult({ stderr, exitCode: failed ? 1 : 0 })]
}

export async function realpathGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stat: (p: PathSpec) => Promise<unknown>,
): Promise<CommandFnResult> {
  const pathStat: StatFn =
    ctx.vfs !== undefined
      ? dispatchStat(ctx.vfs.dispatch)
      : async (path) => (await stat(path)) as FileStat
  return realpath(paths, pathStat, ctx.cwd.virtual, linkTarget(linksOf(ctx)), parseFlags(ctx.flags))
}
