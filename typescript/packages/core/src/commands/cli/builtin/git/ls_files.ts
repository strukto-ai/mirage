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

import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { IOResult } from '../../../../io/types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import {
  AmbiguousArgumentError,
  ConfigUsageError,
  EmptyPathspecError,
  GitError,
  InvalidRevisionNameError,
  UsageError,
} from './errors.ts'
import { readIndex } from './index_file.ts'
import { GITIGNORE, IgnoreStack, INFO_EXCLUDE } from './ignore.ts'
import { abbrevWidth } from './format.ts'
import { readOptional } from './io.ts'
import {
  namedWhole,
  narrowedUntracked,
  pathspecPatterns,
  pathspecSelects,
  patternRoots,
  repoRelative,
  visibleEntries,
} from './pathspec.ts'
import { uniqueAbbreviations } from './ref_list.ts'
import { quotePath, relativePath } from './render.ts'
import { configBool, readBlobBytes, type Repo } from './repo.ts'
import { entryPath, printed, type Line } from './rows.ts'
import { placeNamed } from './seen.ts'
import { opened } from './session.ts'
import { GITLINK, GITLINK_MODE } from './constants.ts'
import { DELETED, workChanges } from './changes.ts'
import { listedTree, resolveTree, TREE_MODE } from './tree.ts'
import { checkSwitches, renderFormat, requireVfs, startPoint, verbUsage } from './util.ts'
import { UNTRACKED_ALL, UNTRACKED_NO, UNTRACKED_NORMAL, scan } from './worktree.ts'
import { encodeText } from '../../../../shell/bytes.ts'

const TAG_CACHED = 'H'
const TAG_UNMERGED = 'M'
const TAG_REMOVED = 'R'
const TAG_MODIFIED = 'C'
const TAG_OTHER = '?'
const LONG_SIZE_WIDTH = 7

/** The exclude rules the line asks for: none unless it names some. */
async function excludes(
  ctx: Context,
  fl: FlagView,
  repo: Repo,
): Promise<[IgnoreStack, string | null]> {
  const vfs = requireVfs(ctx)
  let stack = new IgnoreStack()
  for (const [option, value] of fl.occurrences('exclude_from', 'exclude_standard')) {
    if (option === 'exclude_standard') {
      const shared = await readOptional(vfs, repo.location.commondir.join(INFO_EXCLUDE))
      if (shared !== null) stack = stack.push('', shared)
      continue
    }
    for (const name of Array.isArray(value) ? value : [value]) {
      const data = await readOptional(vfs, startPoint(fl).join(String(name)))
      if (data === null) throw new GitError(`cannot use ${String(name)} as an exclude file`)
      stack = stack.push('', data)
    }
  }
  const perDirectory = fl.asBool('exclude_standard')
    ? GITIGNORE
    : (fl.asStr('exclude_per_directory') ?? null)
  if (perDirectory !== null) {
    const root = await readOptional(vfs, repo.location.worktree.join(perDirectory))
    if (root !== null) stack = stack.push('', root)
  }
  const typed = fl.asList('exclude')
  if (typed.length) stack = stack.commanded(encodeText(typed.map((p) => `${p}\n`).join('')))
  return [stack, perDirectory]
}

/** Which index paths the exclude rules cover, for `-i -c`. */
async function trackedIgnored(
  ctx: Context,
  repo: Repo,
  stack: IgnoreStack,
  perDirectory: string | null,
  names: readonly string[],
): Promise<Set<string>> {
  const vfs = requireVfs(ctx)
  const stacks = new Map<string, IgnoreStack>([['', stack]])
  const rulesOf = async (directory: string): Promise<IgnoreStack> => {
    const known = stacks.get(directory)
    if (known !== undefined) return known
    let rules = await rulesOf(parentOf(directory))
    if (perDirectory !== null) {
      const local = await readOptional(
        vfs,
        repo.location.worktree.join(directory).join(perDirectory),
      )
      if (local !== null) rules = rules.push(directory, local)
    }
    stacks.set(directory, rules)
    return rules
  }
  const ignored = new Set<string>()
  for (const name of names) if ((await rulesOf(parentOf(name))).isIgnored(name)) ignored.add(name)
  return ignored
}

/** Each blob's size in bytes; a tree or a submodule has none. */
async function blobSizes(
  repo: Repo,
  rows: readonly (readonly [string, string, string])[],
): Promise<Map<string, string>> {
  const sizes = new Map<string, string>()
  for (const [, mode, oid] of rows)
    if (mode !== TREE_MODE && mode !== GITLINK_MODE && !sizes.has(oid))
      sizes.set(oid, String((await readBlobBytes(repo, oid)).length))
  return sizes
}

export function parentOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

/**
 * List index paths, and what the work tree holds beside them.
 *
 * Without a pathspec the listing is the start directory's subtree; with one
 * it is whatever the pathspec names, anywhere in the tree, spelled relative to
 * the start directory (`ls-files ..` from a subdirectory prints
 * `../README.md`). Untracked files come first, then each index entry once for
 * every selection it answers to.
 */
export async function lsFiles(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  checkSwitches(ctx, texts)
  const others = fl.asBool('others')
  const modified = fl.asBool('modified')
  const deleted = fl.asBool('deleted')
  const ignored = fl.asBool('ignored')
  const unmerged = fl.asBool('unmerged')
  const stage = fl.asBool('stage') || unmerged
  const template = fl.asStr('format')
  const tags = fl.asBool('t') || fl.asBool('v') || fl.asBool('f')
  const deduplicate = fl.asBool('deduplicate')
  if (template !== undefined && (stage || others || tags || deduplicate))
    throw new UsageError(
      '',
      `fatal: --format cannot be used with -s, -o, -k, -t, --resolve-undo, --deduplicate, --eol\n\n${verbUsage(ctx)}`,
    )
  const cached =
    fl.asBool('cached') || fl.asBool('stage') || !(others || modified || deleted || unmerged)
  if (ignored && !(others || fl.asBool('cached')))
    throw new GitError('ls-files -i must be used with either -o or -c')
  const repo = await opened(ctx, fl)
  const vfs = requireVfs(ctx)
  const fully = await configBool(repo, 'core.quotepath', true)
  const state = await readIndex(repo, repo.vfs)
  const start = startPoint(fl).virtual
  const prefix = repoRelative(repo.location, start, '.')
  const patterns = pathspecPatterns(repo.location, start, texts)
  const scope = patterns.length ? patterns : [prefix]
  const fullName = fl.asBool('full_name')
  const nul = fl.asBool('z')
  const end = nul ? '\0' : '\n'
  const [stack, perDirectory] = await excludes(ctx, fl, repo)
  const labelOf = (name: string): string => {
    const shown = fullName ? name : relativePath(name, prefix)
    return nul ? shown : quotePath(shown, false, fully)
  }
  const out: Line[] = []
  const listed: string[] = []
  let changes = new Map<string, string>()
  if (others || modified || deleted) {
    const tracked = new Set([
      ...visibleEntries(repo.location, state.entries).keys(),
      ...visibleEntries(repo.location, state.conflicts).keys(),
    ])
    const found = await scan(
      vfs,
      repo.location,
      tracked,
      others ? (fl.asBool('directory') ? UNTRACKED_NORMAL : UNTRACKED_ALL) : UNTRACKED_NO,
      ignored,
      null,
      stack,
      perDirectory,
      fl.asBool('directory') && !fl.asBool('no_empty_directory'),
    )
    changes = await workChanges(repo, vfs, repo.location.worktree, state.entries, found)
    if (others) {
      let untracked = found.untracked
      if (!ignored) {
        let files: string[] = []
        if (untracked.some((name) => name.endsWith('/') && !namedWhole(name.slice(0, -1), scope))) {
          const every = await scan(
            vfs,
            repo.location,
            tracked,
            UNTRACKED_ALL,
            false,
            patternRoots(scope),
            stack,
            perDirectory,
          )
          files = every.untracked
        }
        untracked = narrowedUntracked(untracked, files, scope)
      }
      for (const name of [...(ignored ? found.ignored : untracked)].sort(compareCodePoints)) {
        const bare = name.replace(/\/$/, '')
        if (ignored && !pathspecSelects(bare, scope)) continue
        listed.push(bare)
        out.push({
          path: repo.location.worktree.join(bare),
          text: `${tags ? `${TAG_OTHER} ` : ''}${labelOf(name)}${end}`,
        })
      }
    }
  }
  const rows = [...state.entries.values()]
  for (const conflict of state.conflicts.values()) {
    for (const entry of [conflict.ancestor, conflict.this, conflict.other])
      if (entry) rows.push(entry)
  }
  rows.sort((a, b) => compareCodePoints(a.path, b.path) || a.stage - b.stage)
  const excluded =
    ignored && cached
      ? await trackedIgnored(
          ctx,
          repo,
          stack,
          perDirectory,
          rows.map((entry) => entry.path),
        )
      : new Set<string>()
  const wanted = fl.raw('abbrev')
  const width = wanted === undefined ? null : abbrevWidth(wanted, repo.abbrev)
  const lengths =
    width !== null && stage
      ? await uniqueAbbreviations(repo, new Map(rows.map((entry) => [entry.oid, width])))
      : new Map<string, number>()
  const printedPaths = new Set<string>()
  for (const entry of rows) {
    if (!pathspecSelects(entry.path, scope)) continue
    if (unmerged && entry.stage === 0) continue
    if (ignored && cached && !excluded.has(entry.path)) continue
    const code = changes.get(entry.path)
    const short = entry.oid.slice(0, lengths.get(entry.oid) ?? entry.oid.length)
    const selections: [boolean, string][] = [
      [cached || unmerged, entry.stage > 0 ? TAG_UNMERGED : TAG_CACHED],
      [deleted && code === DELETED, TAG_REMOVED],
      [modified && code !== undefined, TAG_MODIFIED],
    ]
    for (const [chosen, letter] of selections) {
      if (!chosen || (deduplicate && printedPaths.has(entry.path))) continue
      printedPaths.add(entry.path)
      listed.push(entry.path)
      const label = labelOf(entry.path)
      const mode = entry.mode.toString(8).padStart(6, '0')
      const text =
        template !== undefined
          ? renderFormat(
              template,
              {
                objectmode: mode,
                objecttype: entry.mode === GITLINK ? 'commit' : 'blob',
                objectname: entry.oid,
                stage: String(entry.stage),
                path: label,
              },
              'ls-files',
            )
          : `${tags ? `${letter} ` : ''}${stage ? `${mode} ${short} ${String(entry.stage)}\t` : ''}${label}`
      out.push({ path: entryPath(repo.location, entry.path), text: text + end })
    }
  }
  const io = new IOResult({ rows: { items: out, render: printed } })
  if (fl.asBool('error_unmatch')) {
    const missing = texts.filter(
      (_typed, at) => !listed.some((name) => pathspecSelects(name, [patterns[at] ?? ''])),
    )
    if (missing.length) {
      const told = missing
        .map((typed) => `error: pathspec '${typed}' did not match any file(s) known to git\n`)
        .join('')
      io.exitCode = 1
      io.stderr = encodeText(`${told}Did you forget to 'git add'?\n`)
    }
  }
  return [null, io]
}

/** List tree metadata without reading file contents. */
export async function lsTree(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  checkSwitches(ctx, texts)
  const [name, ...paths] = texts
  if (name === undefined) throw new UsageError('', verbUsage(ctx))
  const repo = await opened(ctx, fl)
  let tree: string
  try {
    tree = await resolveTree(repo, name)
  } catch (err) {
    if (err instanceof AmbiguousArgumentError || err instanceof InvalidRevisionNameError)
      throw new GitError(`Not a valid object name ${name}`)
    throw err
  }
  // Each row stands where the tree does, so the hides it is filtered by are
  // the ones at that place, not at the root.
  const base = await placeNamed(repo, name, tree)
  const fullTree = fl.asBool('full_tree')
  const start = fullTree ? repo.location.worktree.virtual : startPoint(fl).virtual
  const prefix = repoRelative(repo.location, start, '.')
  let patterns = paths.map((path) => {
    if (path === '') throw new EmptyPathspecError()
    const relative = repoRelative(repo.location, start, path)
    const directory = /(?:^|\/)(?:\.\.?|)$/.test(path)
    return relative + (relative && directory ? '/' : '')
  })
  if (!patterns.length && prefix) patterns = [prefix + '/']
  const rows = await listedTree(
    repo,
    tree,
    patterns,
    fl.asBool('r'),
    fl.asBool('t'),
    fl.asBool('d'),
  )
  const fully = await configBool(repo, 'core.quotepath', true)
  const nul = fl.asBool('z')
  const names = fl.asBool('name_only') || fl.asBool('name_status')
  const long = fl.asBool('long')
  const objectOnly = fl.asBool('object_only')
  const template = fl.asStr('format')
  if (names && long)
    throw new ConfigUsageError("options '--name-only' and '-l' cannot be used together")
  if (names && objectOnly)
    throw new ConfigUsageError("options '--name-only' and '--object-only' cannot be used together")
  if (template !== undefined && (names || long || objectOnly))
    throw new UsageError(
      '',
      `fatal: --format can't be combined with other format-altering options\n\n${verbUsage(ctx)}`,
    )
  const fullName = fullTree || fl.asBool('full_name')
  const terminator = nul ? '\0' : '\n'
  const wanted = fl.raw('abbrev')
  const width = wanted === undefined ? null : abbrevWidth(wanted, repo.abbrev)
  const lengths =
    width === null
      ? new Map<string, number>()
      : await uniqueAbbreviations(repo, new Map(rows.map((row) => [row[2], width])))
  const sizes =
    long || template?.includes('%(objectsize') === true
      ? await blobSizes(repo, rows)
      : new Map<string, string>()
  const out: Line[] = []
  for (const [path, mode, oid] of rows) {
    const relative = fullName ? path : relativePath(path, prefix)
    const label = nul ? relative : quotePath(relative, false, fully)
    const kind = mode === TREE_MODE ? 'tree' : mode === GITLINK_MODE ? 'commit' : 'blob'
    const shown = oid.slice(0, lengths.get(oid) ?? oid.length)
    const size = sizes.get(oid) ?? '-'
    const padded = size.padStart(LONG_SIZE_WIDTH)
    const text =
      template !== undefined
        ? renderFormat(
            template,
            {
              objectmode: mode,
              objecttype: kind,
              objectname: shown,
              objectsize: size,
              'objectsize:padded': padded,
              path: label,
            },
            'ls-tree',
          ) + terminator
        : objectOnly
          ? shown + terminator
          : long
            ? `${mode} ${kind} ${shown} ${padded}\t${label}${terminator}`
            : (names ? '' : `${mode} ${kind} ${shown}\t`) + label + terminator
    out.push({ path: entryPath(repo.location, base ? `${base}/${path}` : path), text })
  }
  return [null, new IOResult({ rows: { items: out, render: printed } })]
}
