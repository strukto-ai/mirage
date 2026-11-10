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
import { HEAD, TERMINATED_KINDS } from './constants.ts'
import { dateClock, parseDateMode, showDate } from './dates.ts'
import { Decoration, type DateMode, type GitObject, type MailmapEntry } from './types.ts'
import git from 'isomorphic-git'

import { IOResult, type ByteSource } from '../../../../io/types.ts'
import { concat } from '../../../../utils/bytes.ts'
import { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { AmbiguousArgumentError, GitError, UsageError } from './errors.ts'
import type { CommitFacts, LogFormat } from './format.ts'
import { decorations, displayed, prettyFormat } from './history.ts'
import {
  commitDeltas,
  commitEntry,
  shows,
  commitOutput,
  commitShown,
  commitSides,
  compare,
  entries,
  filtered,
  parseDiffFlags,
  renderChanges,
  renamesEnabled,
  type DiffFlags,
} from './diff_output.ts'
import { exists } from './io.ts'
import { absoluteOperand, pathspecPatterns } from './pathspec.ts'
import { identDate } from './ref_fields.ts'
import { commitFacts, configBool, rawObject, repoArgs, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { resolveCommit, resolveObject, treeId } from './revparse.ts'
import { deltas, shownSides, type Delta, type Side } from './rows.ts'
import { decoded, located, placeNamed, shownItems } from './seen.ts'
import {
  checkOperands,
  loneHelp,
  optionOperand,
  revisionArg,
  splitMarked,
  startPoint,
  verbUsage,
} from './util.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/**
 * The parsed shape of a `git show` invocation.
 *
 * `--no-ext-diff` is accepted but carries no field: there are no external
 * diff drivers here, so it changes nothing by construction.
 */
interface ShowFlags {
  readonly diff: DiffFlags
  readonly pretty: LogFormat
  /**
   * Print an abbreviated id, which `--oneline` implies and `--pretty=oneline`
   * alone does not.
   */
  readonly abbrevCommit: boolean
  readonly date: DateMode
  readonly mailmap: readonly MailmapEntry[]
  readonly useMailmap: boolean
  /**
   * How the commit is labelled with its refs; parseShowFlags leaves it off,
   * and `decorationFor` settles it once the repository's config can be read.
   */
  readonly decorate: Decoration
}

/** Read the raw show flag kwargs into a frozen struct. */
function parseShowFlags(
  fl: FlagView,
  defaultRenames = true,
  quotePathFully = true,
  env: Readonly<Record<string, string>> | null = null,
): ShowFlags {
  const pretty = prettyFormat(fl)
  return {
    mailmap: [],
    useMailmap: true,
    decorate: Decoration.NONE,
    abbrevCommit: fl.asBool('oneline'),
    date: parseDateMode(fl.asStr('date', 'default'), dateClock(env)),
    diff: parseDiffFlags(fl, true, 'dense-combined', true, defaultRenames, quotePathFully),
    pretty,
  }
}

const DEC = new TextDecoder()
/**
 * The tagger as the format shows a person: nothing for oneline, the date under
 * medium, `TaggerDate` under fuller, and the name alone otherwise.
 */
function taggerLines(ident: string, flags: ShowFlags): string {
  const kind = flags.pretty.kind
  const close = ident.indexOf('>', ident.indexOf(' <'))
  const date = identDate(ident)
  if (kind === 'oneline' || !ident.includes(' <') || close === -1 || date === null) return ''
  const who = ident.slice(0, close + 1)
  const when = showDate(date[0], date[1], flags.date)
  if (kind === 'medium') return `Tagger: ${who}\nDate:   ${when}\n`
  if (kind === 'fuller') return `Tagger:     ${who}\nTaggerDate: ${when}\n`
  return `Tagger: ${who}\n`
}

/**
 * What `git show` prints for an annotated tag ahead of the object it points
 * at, and that object: `tag <name>`, the tagger, then the rest of the tag from
 * its blank line on, which is its message as written. Pinned against git
 * 2.50.1.
 */
async function tagBlock(repo: Repo, oid: string, flags: ShowFlags): Promise<[string, GitObject]> {
  // The raw content is what git prints from, signature and all.
  const text = DEC.decode((await rawObject(repo, oid)).raw)
  const end = text.indexOf('\n\n')
  const fields = (end === -1 ? text : text.slice(0, end)).split('\n')
  const value = (key: string): string =>
    fields.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1) ?? ''
  const block = `tag ${value('tag')}\n${taggerLines(value('tagger'), flags)}`
  return [
    block + (end === -1 ? '' : text.slice(end + 1)),
    { oid: value('object'), type: value('type') },
  ]
}

/**
 * Every commit a line shows the diff of, tags peeled. A tree it lists is read
 * here, so an entry git refuses refuses the line before anything prints; a
 * tag's tree the session cannot see is left to `render` to skip. Mirrors
 * Python's `_commits`.
 */
async function commits(
  repo: Repo,
  objects: readonly [string, GitObject][],
  flags: ShowFlags,
): Promise<CommitFacts[]> {
  const found: CommitFacts[] = []
  for (const [, obj] of objects) {
    let target = obj
    const tagged = target.type === 'tag'
    while (target.type === 'tag') target = (await tagBlock(repo, target.oid, flags))[1]
    if (target.type === 'tree') {
      if (!tagged || (await located(repo, target)) !== null)
        decoded((await git.readTree({ ...repoArgs(repo), oid: target.oid })).tree)
    } else if (target.type !== 'blob') found.push(await commitFacts(repo, target.oid))
  }
  return found
}

/**
 * Show each object a line names, in order: a commit as its log entry and its
 * diff against its parent, an annotated tag as its own block ahead of what it
 * points at, a tree as its listing and a blob as its bytes.
 *
 * Every name resolves before anything prints, and a commit named twice prints
 * once. A blank line goes ahead of every tag and tree but the first thing shown,
 * and ahead of every later commit unless the format ends each entry itself
 * (oneline, tformat); a blob takes none and counts for none. Pinned against git
 * 2.50.1.
 *
 * Operands after `--` are pathspecs, read once the revision has resolved, as
 * git reads them; they limit the diff to the paths they name, and a commit
 * that changes nothing they name prints nothing at all.
 */
export async function show(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  checkOperands(ctx, texts)
  const [revisions, paths] = splitMarked(texts, ctx.argv ?? [])
  const repo = await opened(ctx, fl)
  const base = parseShowFlags(
    fl,
    await renamesEnabled(repo),
    await configBool(repo, 'core.quotepath', true),
    ctx.env,
  )
  const [mailmap, mapped, decorate] = await displayed(repo, fl, base.pretty)
  const names = revisions.length > 0 ? revisions : [HEAD]
  const objects: [string, GitObject][] = []
  for (const name of names) objects.push([name, await resolveObject(repo, name)])
  const pathspecs = pathspecPatterns(repo.location, startPoint(fl).virtual, paths)
  const parsed = {
    ...base,
    mailmap,
    useMailmap: mapped,
    decorate,
    diff: { ...base.diff, pathspecs },
  }
  const decor = await decorations(repo, parsed.decorate)
  const terminated = TERMINATED_KINDS.includes(parsed.pretty.kind)
  const [rows, spans] = await commitDeltas(repo, await commits(repo, objects, parsed), parsed.diff)
  const render = async (shown: Delta[]): Promise<ByteSource> => {
    const sides = commitShown(shown, spans)
    const parts: Uint8Array[] = []
    const shownCommits = new Set<string>()
    let shownOne = false
    for (const [name, obj] of objects) {
      let target = obj
      const tagged = target.type === 'tag'
      while (target.type === 'tag') {
        const [block, next] = await tagBlock(repo, target.oid, parsed)
        parts.push(encodeText(`${shownOne ? '\n' : ''}${block}`))
        shownOne = true
        target = next
      }
      // A tag can point past every commit at a tree or a blob, which is
      // shown only where the session sees it.
      if (tagged && (await located(repo, target)) === null) continue
      if (target.type === 'blob') {
        parts.push((await git.readBlob({ ...repoArgs(repo), oid: target.oid })).blob)
        continue
      }
      if (target.type === 'tree') {
        const base = await placeNamed(repo, name, target.oid)
        const body = (await shownItems(repo, target.oid, base))
          .map((entry) => entry.path + (entry.type === 'tree' ? '/' : '') + '\n')
          .join('')
        parts.push(encodeText(`${shownOne ? '\n' : ''}tree ${name}\n\n${body}`))
        shownOne = true
        continue
      }
      if (shownCommits.has(target.oid)) continue
      shownCommits.add(target.oid)
      const facts = await commitFacts(repo, target.oid)
      if (parsed.diff.diffFilter && !(await shows(repo, facts, parsed.diff))) continue
      const entry = await commitEntry(
        repo,
        facts,
        parsed,
        parsed.diff,
        sides.get(facts.oid) ?? [],
        decor,
        parsed.diff.summary && !parsed.diff.noPatch && parsed.pretty.kind !== 'oneline',
      )
      parts.push(encodeText(`${shownOne && !terminated ? '\n' : ''}${entry}`))
      shownOne = true
    }
    return concat(parts)
  }
  return [null, new IOResult({ rows: { items: rows, render } })]
}

async function twoTrees(
  repo: Repo,
  first: string,
  second: string,
  flags: DiffFlags,
  recursive: boolean,
): Promise<Side[]> {
  return [
    [
      await entries(repo, await treeId(repo, first), recursive, flags.pathspecs),
      await entries(repo, await treeId(repo, second), recursive, flags.pathspecs),
    ],
  ]
}

async function treesOutput(repo: Repo, side: Side, flags: DiffFlags): Promise<[string, boolean]> {
  const rows = await compare(repo, side[0], side[1], flags.renames)
  return [await renderChanges(repo, rows, flags), filtered(rows, flags).length > 0]
}

/**
 * The other tree-ish a line names, and the paths that follow it: the word after
 * the first is a tree-ish if it resolves, and a path when it does not but
 * exists; anything else names nothing.
 */
async function secondTree(
  fl: FlagView,
  repo: Repo,
  words: readonly string[],
): Promise<[string | null, readonly string[]]> {
  const word = words[0]
  if (word === undefined) return [null, []]
  try {
    await resolveObject(repo, word)
  } catch (err) {
    if (!(err instanceof GitError)) throw err
    const where = absoluteOperand(startPoint(fl).virtual, word)
    if (await exists(repo.vfs, PathSpec.fromStrPath(where))) return [null, words]
    throw new AmbiguousArgumentError(word)
  }
  return [word, words.slice(1)]
}

/** Compare a commit with its parents, or two trees. */
export async function diffTree(
  _accessor: NOOPAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  if (optionOperand(ctx, texts, loneHelp(ctx, texts)) !== null) {
    throw new UsageError('', verbUsage(ctx))
  }
  const repo = await opened(ctx, fl)
  let parsed = parseDiffFlags(
    fl,
    false,
    'off',
    false,
    false,
    await configBool(repo, 'core.quotepath', true),
  )
  const quiet = fl.asBool('quiet')
  const report = quiet || fl.asBool('exit_code')
  if (quiet) parsed = { ...parsed, noPatch: true }
  const [revisions, paths] = splitMarked(texts, ctx.argv ?? [])
  const first = revisionArg(revisions)
  const [second, spare] = await secondTree(fl, repo, revisions.slice(1))
  const pathspecs = pathspecPatterns(repo.location, startPoint(fl).virtual, [...spare, ...paths])
  const flags = { ...parsed, pathspecs }
  const recursive = fl.asBool('r') || flags.patch
  if (second !== null) {
    const pair = await twoTrees(repo, first, second, flags, recursive)
    const renderTrees = async (shown: Delta[]): Promise<ByteSource | null> => {
      const side = shownSides(shown, 1)[0] ?? [new Map(), new Map()]
      const [body, differs] = await treesOutput(repo, side, flags)
      if (report && differs) treesIo.exitCode = 1
      if (quiet) return null
      return body === '' ? null : encodeText(body)
    }
    const treesIo = new IOResult({
      rows: { items: deltas(repo.location, pair), render: renderTrees },
    })
    return [null, treesIo]
  }
  const found = await resolveObject(repo, first)
  if (found.type === 'tree') {
    return [
      null,
      new IOResult({
        stderr: new TextEncoder().encode(`error: object ${found.oid} is a tree, not a commit\n`),
      }),
    ]
  }
  const commit = await commitFacts(repo, await resolveCommit(repo, first))
  const sides = await commitSides(repo, commit, flags, recursive, fl.asBool('root'))
  const render = async (shown: Delta[]): Promise<ByteSource> => {
    const bodies = await commitOutput(repo, commit, flags, shownSides(shown, sides.length))
    const out = bodies
      .filter((body) => body !== null)
      .map((body) => (fl.asBool('no_commit_id') ? '' : commit.oid + '\n') + body)
      .join('')
    if (report && out !== '') io.exitCode = 1
    return encodeText(out)
  }
  const io = new IOResult({ rows: { items: deltas(repo.location, sides), render } })
  return [null, io]
}
