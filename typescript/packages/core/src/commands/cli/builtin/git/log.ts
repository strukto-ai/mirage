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

import { loadMailmap, useMailmap } from './mailmap.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { GitError } from './errors.ts'
import {
  joinOutput,
  commitOutput,
  parseDiffFlags,
  renamesEnabled,
  separatorLine,
  type DiffFlags,
} from './diff_output.ts'
import {
  FULL_SHA,
  oneline,
  presetBlock,
  renderTemplate,
  type CommitFacts,
  type Decorations,
} from './format.ts'
import { CommitGraph } from './graph.ts'
import {
  decorationFor,
  decorations,
  parseFlags,
  refCommits,
  select,
  walked,
  type LogFlags,
  type Walk,
} from './history.ts'
import { configBool, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { splitRevisions } from './revparse.ts'
import { checkOperands, fatal } from './util.ts'
import { HEAD } from './constants.ts'
import { Decoration } from './types.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/**
 * The text a log invocation prints for its selected commits.
 *
 * `format:` separates entries with a newline and ends without one, and an
 * entry that renders empty still claims its separator, so `--pretty=format:`
 * prints one newline per commit past the first. `tformat:` (and any bare `%`
 * string) terminates every entry, empty ones included - except that an empty
 * template prints nothing at all, which is how `--format=` stays silent.
 * The caller encodes through `encodeText` because `%xHH` names a raw byte.
 * Pinned against git 2.37 and 2.54.
 */
function rendered(
  commits: readonly CommitFacts[],
  flags: LogFlags,
  width: number,
  decor: Decorations | null,
): string {
  const fmt = flags.pretty
  if (fmt.kind === 'oneline') {
    const length = flags.abbrevCommit ? width : FULL_SHA
    const lines = commits.map((commit) =>
      flags.decorate !== Decoration.NONE
        ? renderTemplate('%h%d %s', commit, length, decor)
        : oneline(commit, length),
    )
    return lines.length > 0 ? `${lines.join('\n')}\n` : ''
  }
  if (fmt.kind === 'format' || fmt.kind === 'tformat') {
    const entries = commits.map((commit) =>
      renderTemplate(fmt.template ?? '', commit, width, decor, flags.date, flags.mailmap),
    )
    if (fmt.kind === 'tformat') {
      if (fmt.template === null || fmt.template === '') return ''
      return entries.map((text) => `${text}\n`).join('')
    }
    return entries.join('\n')
  }
  const lines: string[] = []
  const mailmap = flags.useMailmap ? flags.mailmap : []
  commits.forEach((commit, index) => {
    if (index > 0) lines.push('')
    const block = presetBlock(commit, fmt.kind, width, flags.date, mailmap)
    if (flags.decorate !== Decoration.NONE && block[0]?.startsWith('commit '))
      block[0] += renderTemplate('%d', commit, width, decor)
    lines.push(...block)
  })
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/**
 * The text a `--graph` log prints: git's show_log, commit by commit.
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
 * before a combined diff, which git prints from its own path.
 *
 * @param repo the opened repository
 * @param walk the walked commits and the ones an edge may lead to
 * @param flags the parsed invocation
 * @param decor ref labels per commit, when the format prints any
 * @param diff the diff flags, null when no diff was asked for
 */
async function graphed(
  repo: Repo,
  walk: Walk,
  flags: LogFlags,
  decor: Decorations | null,
  diff: DiffFlags | null,
): Promise<string> {
  const width = repo.abbrev
  const graph = new CommitGraph((oid) => walk.interesting.has(oid), flags.firstParent)
  const mailmap = flags.useMailmap ? flags.mailmap : []
  const fmt = flags.pretty
  const user = fmt.kind === 'format' || fmt.kind === 'tformat'
  const terminated = fmt.kind === 'oneline' || fmt.kind === 'tformat'
  const empty = user && (fmt.template ?? '') === ''
  const length = fmt.kind === 'oneline' && !flags.abbrevCommit ? FULL_SHA : width
  let out = ''
  let shownOne = false
  let missingNewline = false
  for (const { commit, shown } of walk.steps) {
    graph.update(commit)
    if (!shown) continue
    const bodies = diff === null ? [] : await commitOutput(repo, commit, diff)
    const blocks: [string | null, string][] = []
    bodies.forEach((body, index) => {
      if (body !== null)
        blocks.push([bodies.length > 1 ? (commit.parents[index] ?? null) : null, body])
    })
    if (!blocks.length) blocks.push([null, ''])
    for (const [parent, body] of blocks) {
      if (shownOne && !terminated) {
        if (!missingNewline) out += graph.paddingLine()
        out += '\n'
      }
      shownOne = true
      out += graph.showCommit()
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
        text = renderTemplate(fmt.template ?? '', commit, width, decor, flags.date, flags.mailmap)
      } else {
        const [head = '', ...rest] = presetBlock(commit, fmt.kind, width, flags.date, mailmap)
        out += `${head}${from}${labels}\n${graph.nextLine()[0]}`
        text = rest.map((line) => `${line}\n`).join('')
      }
      missingNewline = !text.endsWith('\n')
      out += graph.showMessage(text)
      if (terminated && !empty) {
        if (!missingNewline) out += graph.paddingLine()
        out += '\n'
      }
      if (body === '' || diff === null) continue
      const separator = empty ? null : separatorLine(commit, fmt.kind, diff)
      if (separator !== null) out += `${graph.paddingLine()}${separator}\n`
      for (const line of body.split('\n').slice(0, -1)) out += `${graph.paddingLine()}${line}\n`
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
): Promise<[CommitFacts[], CommitFacts[]]> {
  const [starts, hidden] = await splitRevisions(repo, revisions.length ? revisions : [HEAD])
  if (flags.allRefs) starts.push(...(await refCommits(repo)))
  return [starts, hidden]
}

/** Show commit logs. */
export async function log(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  try {
    checkOperands(inv, texts)
    const flags = parseFlags(fl, inv.env)
    const repo = await opened(fl, doors)
    const parsed = {
      ...flags,
      mailmap: await loadMailmap(repo.dispatch, repo.location),
      useMailmap: useMailmap(fl, await configBool(repo, 'log.mailmap', true)),
      decorate: await decorationFor(repo, fl, flags.pretty),
    }
    const [starts, hidden] = await startingPoints(repo, texts, parsed)
    const decor =
      parsed.decorate === Decoration.NONE ? null : await decorations(repo, parsed.decorate)
    let diffFlags = parseDiffFlags(fl, false)
    const diffing =
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
    if (parsed.graph) {
      const walk = await walked(repo, starts, parsed, hidden)
      const out = await graphed(repo, walk, parsed, decor, diffing ? diffFlags : null)
      return [out === '' ? null : encodeText(out), new IOResult()]
    }
    const commits = await select(repo, starts, parsed, hidden)
    let out: string
    if (diffing) {
      const blocks: string[] = []
      for (const commit of commits) {
        const head = rendered([commit], parsed, repo.abbrev, decor)
        const bodies = await commitOutput(repo, commit, diffFlags)
        blocks.push(joinOutput(commit, head, bodies, parsed.pretty.kind, repo.abbrev, diffFlags))
      }
      out = blocks.join(['tformat', 'oneline'].includes(parsed.pretty.kind) ? '' : '\n')
    } else out = rendered(commits, parsed, repo.abbrev, decor)
    if (out === '') return [null, new IOResult()]
    return [encodeText(out), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
