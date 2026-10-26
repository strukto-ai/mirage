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
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import {
  COMBINED_MODE,
  commitDeltas,
  commitEntry,
  commitOutput,
  commitShown,
  isCombined,
  parseDiffFlags,
  renamesEnabled,
  separatorLine,
  type DiffFlags,
} from './diff_output.ts'
import {
  FULL_SHA,
  commitHeader,
  presetBlock,
  renderTemplate,
  type CommitFacts,
  type Decorations,
} from './format.ts'
import { CommitGraph } from './graph.ts'
import {
  displayed,
  decorations,
  inPrintOrder,
  parseFlags,
  refCommits,
  walkEnds,
  walkOperands,
  walked,
  type LogFlags,
  type Walk,
} from './history.ts'
import { configBool, type Repo } from './repo.ts'
import { opened } from './session.ts'
import type { Delta, Side } from './rows.ts'
import { checkOperands } from './util.ts'
import { HEAD, TEMPLATE_KINDS, TERMINATED_KINDS } from './constants.ts'
import { Decoration } from './types.ts'
import { encodeText } from '../../../../shell/bytes.ts'

// How `--boundary` marks a commit outside `--graph`, and the word a block
// preset's header starts with.
const BOUNDARY_PREFIX = '- '
const COMMIT_WORD = 'commit '

/**
 * A `--boundary` commit's entry outside `--graph`: a oneline row starts `- `,
 * and a block preset's header reads `commit - <id>`; a user format and email
 * print it as they print any commit (git 2.47.3).
 *
 * @param entry the entry as any commit's would read
 * @param kind the pretty format's kind
 */
function marked(entry: string, kind: string): string {
  if (kind === 'oneline') return BOUNDARY_PREFIX + entry
  if (TEMPLATE_KINDS.includes(kind) || !entry.startsWith(COMMIT_WORD)) return entry
  return COMMIT_WORD + BOUNDARY_PREFIX + entry.slice(COMMIT_WORD.length)
}

/**
 * The text a log invocation prints for its selected commits.
 *
 * `format:` separates entries with a newline and ends without one, and an
 * entry that renders empty still claims its separator, so `--pretty=format:`
 * prints one newline per commit past the first; a block preset separates its
 * entries the same way. `tformat:` (and any bare `%` string) and oneline
 * terminate every entry instead. Pinned against git 2.37 and 2.54.
 */
function rendered(
  commits: readonly CommitFacts[],
  flags: LogFlags,
  width: number,
  decor: Decorations | null,
  boundary: ReadonlySet<string> = new Set(),
  parents: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  const terminated = TERMINATED_KINDS.includes(flags.pretty.kind)
  return commits
    .map((commit) => {
      const entry = commitHeader(commit, flags, width, decor, parents.get(commit.oid) ?? null)
      return boundary.has(commit.oid) ? marked(entry, flags.pretty.kind) : entry
    })
    .join(terminated ? '' : '\n')
}

/**
 * The text a `--graph` log prints, commit by commit.
 *
 * Every walked commit moves the graph on, printed or not, so a commit the
 * pickaxe passed by leaves a `...` row. A printed commit gets the graph's lines
 * up to its own, then its header, then its text with the next graph line in
 * front of each further line, then whatever lines the graph still owes. The
 * formats that separate entries (medium and its kin, `format:`) put the
 * separator behind a padding line, so the graph never shows a gap; the ones
 * that terminate entries (oneline, `tformat:`) do the same after each entry.
 * A padding line is skipped wherever the text before it ended without a
 * newline, since it would then land on that text's own line.
 *
 * With a diff each block (one per parent under `-m`) is an entry of its own,
 * each naming its parent, and every diff line sits behind a padding line,
 * the one between the message and the diff included. That line is `---` when
 * both a diffstat and a patch follow, and is left out for oneline, except
 * before a combined diff, which git prints from its own path: a merge's
 * combined diff gets the line even when nothing follows it, as does an empty
 * `--summary` outside oneline, and the combined diff's `mode` lines and its
 * `--name-only` or `--name-status` rows go out with no graph in front of them
 * at all (git 2.47.3).
 *
 * @param repo the opened repository
 * @param walk the walked commits and the ones an edge may lead to
 * @param flags the parsed invocation
 * @param decor ref labels per commit, when the format prints any
 * @param diff the diff flags, null when no diff was asked for
 * @param sides each shown commit's comparisons, as the session sees them,
 *   when a diff was asked for
 */
async function graphed(
  repo: Repo,
  walk: Walk,
  flags: LogFlags,
  decor: Decorations | null,
  diff: DiffFlags | null,
  sides: ReadonlyMap<string, readonly Side[]>,
): Promise<string> {
  const width = repo.abbrev
  const graph = new CommitGraph(
    (oid) => walk.interesting.has(oid),
    flags.firstParent,
    new Set(walk.boundary.map((commit) => commit.oid)),
    walk.parents.size ? walk.parents : null,
  )
  const mailmap = flags.useMailmap ? flags.mailmap : []
  const fmt = flags.pretty
  const user = TEMPLATE_KINDS.includes(fmt.kind)
  const terminated = TERMINATED_KINDS.includes(fmt.kind)
  const empty = user && (fmt.template ?? '') === ''
  const length = fmt.kind === 'oneline' && !flags.abbrevCommit ? FULL_SHA : width
  let out = ''
  let shownOne = false
  let missingNewline = false
  for (const { commit, shown } of [
    ...walk.steps,
    ...walk.boundary.map((commit) => ({ commit, shown: true })),
  ]) {
    graph.walk(commit)
    if (!shown) continue
    const bodies =
      diff === null ? [] : await commitOutput(repo, commit, diff, sides.get(commit.oid) ?? [])
    const blocks: [string | null, string][] = []
    bodies.forEach((body, index) => {
      if (body !== null)
        blocks.push([bodies.length > 1 ? (commit.parents[index] ?? null) : null, body])
    })
    const differs = blocks.length > 0
    if (!differs) blocks.push([null, ''])
    for (const [parent, body] of blocks) {
      if (shownOne && !terminated) {
        if (!missingNewline) out += graph.filler()
        out += '\n'
      }
      shownOne = true
      out += graph.leadIn()
      const from =
        !user && parent !== null
          ? ` (from ${parent.slice(0, fmt.kind === 'oneline' ? length : FULL_SHA)})`
          : ''
      const labels =
        flags.decorate !== Decoration.NONE ? renderTemplate('%d', commit, width, decor) : ''
      let text: string
      if (fmt.kind === 'oneline') {
        out += `${renderTemplate('%h', commit, length, decor)}${from}${labels} `
        text = renderTemplate('%s', commit, length, decor)
      } else if (user) {
        text = renderTemplate(
          fmt.template ?? '',
          commit,
          width,
          decor,
          flags.date,
          flags.mailmap,
          walk.parents.get(commit.oid) ?? null,
        )
      } else {
        const [head = '', ...rest] = presetBlock(
          commit,
          fmt.kind,
          width,
          flags.date,
          mailmap,
          walk.parents.get(commit.oid) ?? null,
        )
        out += `${head}${from}${labels}\n${graph.nextRow()}`
        text = rest.map((line) => `${line}\n`).join('')
      }
      missingNewline = !text.endsWith('\n')
      out += graph.around(text)
      if (terminated && !empty) {
        if (!missingNewline) out += graph.filler()
        out += '\n'
      }
      const combined = diff !== null && isCombined(commit, diff)
      if (diff === null || !differs) continue
      if (body === '' && !(combined || (diff.summary && fmt.kind !== 'oneline'))) continue
      const separator = empty ? null : separatorLine(commit, fmt.kind, diff)
      if (separator !== null) out += `${graph.filler()}${separator}\n`
      const names = combined && (diff.nameOnly || diff.nameStatus)
      for (const line of body.split('\n').slice(0, -1)) {
        const bare = names || (combined && line.startsWith(COMBINED_MODE))
        out += `${bare ? '' : graph.filler()}${line}\n`
      }
    }
  }
  return out
}

/**
 * The commits a log walks from and the commits it hides: the revisions and
 * ranges given, HEAD when there are none, plus every ref for --all.
 */
async function startingPoints(
  repo: Repo,
  revisions: readonly string[],
  flags: LogFlags,
  dashed: boolean,
): Promise<[CommitFacts[], CommitFacts[]]> {
  const [starts, hidden] = await walkEnds(repo, revisions.length ? revisions : [HEAD], dashed)
  if (flags.allRefs) for (const item of await refCommits(repo)) starts.push(item)
  return [starts, hidden]
}

/** Show commit logs. */
export async function log(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags)
  checkOperands(ctx, texts)
  const flags = parseFlags(fl, ctx.env, ctx.signal)
  const repo = await opened(ctx, fl)
  const [revisions, pathspecs, dashed] = await walkOperands(ctx, fl, repo, texts)
  const [mailmap, mapped, decorate] = await displayed(repo, fl, flags.pretty)
  const parsed = { ...flags, mailmap, useMailmap: mapped, decorate, pathspecs }
  const [starts, hidden] = await startingPoints(repo, revisions, parsed, dashed)
  const decor = await decorations(repo, parsed.decorate)
  let diffFlags = parseDiffFlags(fl, false)
  // The pickaxe searches the diff, renames paired, whether or not any of it is
  // printed, which is how `-S -m` comes to name the parent each printed entry
  // matched against.
  const diffing =
    parsed.pickaxe !== null ||
    diffFlags.patch ||
    diffFlags.stat ||
    diffFlags.nameOnly ||
    diffFlags.nameStatus ||
    diffFlags.numstat ||
    diffFlags.shortstat ||
    diffFlags.summary ||
    diffFlags.raw
  if (diffing) {
    diffFlags = parseDiffFlags(
      fl,
      false,
      'off',
      true,
      await renamesEnabled(repo),
      await configBool(repo, 'core.quotepath', true),
    )
  }
  diffFlags = { ...diffFlags, pickaxe: parsed.pickaxe, pathspecs }
  const walk = await walked(repo, starts, parsed, hidden, diffFlags)
  const commits = inPrintOrder(walk, parsed)
  const boundary = new Set(walk.boundary.map((commit) => commit.oid))
  if (!diffing) {
    const out = parsed.graph
      ? await graphed(repo, walk, parsed, decor, null, new Map())
      : rendered(commits, parsed, repo.abbrev, decor, boundary, walk.parents)
    return [out === '' ? null : encodeText(out), new IOResult()]
  }
  const shownCommits = parsed.graph
    ? [...walk.steps.filter((step) => step.shown).map((step) => step.commit), ...walk.boundary]
    : commits
  const [rows, spans] = await commitDeltas(repo, shownCommits, diffFlags)
  // A commit whose summary is empty still gets the blank line under its
  // header, as `show` gives one, though not under oneline (git 2.47.3).
  const summary = diffFlags.summary && !diffFlags.noPatch && parsed.pretty.kind !== 'oneline'
  const render = async (shown: Delta[]): Promise<ByteSource | null> => {
    const sides = commitShown(shown, spans)
    let out: string
    if (parsed.graph) out = await graphed(repo, walk, parsed, decor, diffFlags, sides)
    else {
      const blocks: string[] = []
      for (const commit of commits) {
        const entry = await commitEntry(
          repo,
          commit,
          parsed,
          diffFlags,
          sides.get(commit.oid) ?? [],
          decor,
          summary,
          walk.parents.get(commit.oid) ?? null,
        )
        blocks.push(boundary.has(commit.oid) ? marked(entry, parsed.pretty.kind) : entry)
      }
      out = blocks.join(TERMINATED_KINDS.includes(parsed.pretty.kind) ? '' : '\n')
    }
    return out === '' ? null : encodeText(out)
  }
  return [null, new IOResult({ rows: { items: rows, render } })]
}
