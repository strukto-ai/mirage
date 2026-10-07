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

import { HEAD } from './constants.ts'
import { loadMailmap, useMailmap } from './mailmap.ts'
import { dateClock, parseDateMode, showDate } from './dates.ts'
import { Decoration, type DateMode, type GitObject, type MailmapEntry } from './types.ts'
import git from 'isomorphic-git'

import { IOResult } from '../../../../io/types.ts'
import { concat } from '../../../../io/cachable_iterator.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { GitError, UsageError } from './errors.ts'
import {
  FULL_SHA,
  oneline,
  presetBlock,
  renderTemplate,
  type CommitFacts,
  type Decorations,
  type LogFormat,
} from './format.ts'
import { decorationFor, decorations, prettyFormat } from './history.ts'
import {
  joinOutput,
  commitOutput,
  parseDiffFlags,
  renamesEnabled,
  type DiffFlags,
} from './diff_output.ts'
import { pathspecPatterns } from './pathspec.ts'
import { identDate } from './ref_fields.ts'
import { commitFacts, configBool, repoArgs, type Repo } from './repo.ts'
import { opened } from './session.ts'
import { resolveCommit, resolveObject } from './revparse.ts'
import {
  checkOperands,
  fatal,
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
    date: parseDateMode(fl.asStr('date') ?? 'default', dateClock(env)),
    diff: parseDiffFlags(fl, true, 'dense-combined', true, defaultRenames, quotePathFully),
    pretty,
  }
}

/**
 * The commit header in the requested format.
 *
 * `format:` is a separator, so a single commit prints with no trailing
 * newline at all; `tformat:` terminates the entry even when it renders
 * empty, except that an empty template prints nothing, matching
 * `log --format=`. Pinned against git 2.37 and 2.54. A decorated preset
 * labels the commit after its id, as `log` does.
 */
function header(
  commit: CommitFacts,
  flags: ShowFlags,
  width: number,
  decor: Decorations | null,
): string {
  const fmt = flags.pretty
  const decorated = flags.decorate !== Decoration.NONE
  if (fmt.kind === 'oneline') {
    const length = flags.abbrevCommit ? width : FULL_SHA
    return `${decorated ? renderTemplate('%h%d %s', commit, length, decor) : oneline(commit, length)}\n`
  }
  if (fmt.kind === 'format' || fmt.kind === 'tformat') {
    const text = renderTemplate(fmt.template ?? '', commit, width, decor, flags.date, flags.mailmap)
    if (fmt.kind === 'tformat') {
      return fmt.template === null || fmt.template === '' ? '' : `${text}\n`
    }
    return text
  }
  const block = presetBlock(
    commit,
    fmt.kind,
    width,
    flags.date,
    flags.useMailmap ? flags.mailmap : [],
  )
  if (decorated && block[0]?.startsWith('commit '))
    block[0] += renderTemplate('%d', commit, width, decor)
  return `${block.join('\n')}\n`
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
  // Deprecated upstream for being general, but the raw content is what git
  // prints from, signature and all.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const read = await git.readObject({ ...repoArgs(repo), oid, format: 'content' })
  const text = DEC.decode(read.object as Uint8Array)
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
 * A commit's log entry and its diff against its parent. A commit that changes
 * nothing the pathspec names prints nothing at all.
 */
async function commitEntry(
  repo: Repo,
  oid: string,
  flags: ShowFlags,
  decor: Decorations | null,
): Promise<string> {
  const facts = await commitFacts(repo, oid)
  const head = header(facts, flags, repo.abbrev, decor)
  const bodies = await commitOutput(repo, facts, flags.diff)
  const combined =
    facts.parents.length > 1 &&
    (flags.diff.merge === 'combined' || flags.diff.merge === 'dense-combined')
  return joinOutput(
    facts,
    head,
    bodies,
    flags.pretty.kind,
    repo.abbrev,
    flags.diff,
    (flags.diff.summary || combined) && !flags.diff.noPatch,
  )
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
export async function show(inv: CLIInvocation): Promise<CommandFnResult> {
  const doors = inv.doors ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  try {
    checkOperands(inv, texts)
    const [revisions, paths] = splitMarked(texts, inv.argv)
    const repo = await opened(fl, doors)
    const base = parseShowFlags(
      fl,
      await renamesEnabled(repo),
      await configBool(repo, 'core.quotepath', true),
      inv.env,
    )
    const mailmap = await loadMailmap(repo.dispatch, repo.location)
    const mapped = useMailmap(fl, await configBool(repo, 'log.mailmap', true))
    const decorate = await decorationFor(repo, fl, base.pretty)
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
    const decor =
      parsed.decorate === Decoration.NONE ? null : await decorations(repo, parsed.decorate)
    const terminated = parsed.pretty.kind === 'oneline' || parsed.pretty.kind === 'tformat'
    const parts: Uint8Array[] = []
    const shownCommits = new Set<string>()
    let shownOne = false
    for (const [name, obj] of objects) {
      let target = obj
      while (target.type === 'tag') {
        const [block, next] = await tagBlock(repo, target.oid, parsed)
        parts.push(encodeText(`${shownOne ? '\n' : ''}${block}`))
        shownOne = true
        target = next
      }
      if (target.type === 'blob') {
        parts.push((await git.readBlob({ ...repoArgs(repo), oid: target.oid })).blob)
        continue
      }
      if (target.type === 'tree') {
        const { tree } = await git.readTree({ ...repoArgs(repo), oid: target.oid })
        const body = tree
          .map((entry) => entry.path + (entry.type === 'tree' ? '/' : '') + '\n')
          .join('')
        parts.push(encodeText(`${shownOne ? '\n' : ''}tree ${name}\n\n${body}`))
        shownOne = true
        continue
      }
      if (shownCommits.has(target.oid)) continue
      shownCommits.add(target.oid)
      const entry = await commitEntry(repo, target.oid, parsed, decor)
      parts.push(encodeText(`${shownOne && !terminated ? '\n' : ''}${entry}`))
      shownOne = true
    }
    return [concat(parts), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}

/**
 * Compare a commit with its parents.
 *
 * Every block opens with the commit id unless `--no-commit-id`, and a parent
 * the commit does not differ from prints nothing, id included. Operands after
 * `--` are pathspecs, read once the commit has resolved; they limit every block
 * to the paths they name.
 */
export async function diffTree(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  try {
    if (optionOperand(inv, inv.texts) !== null) throw new UsageError('', verbUsage(inv))
    const repo = await opened(fl, inv.doors ?? {})
    const parsed = parseDiffFlags(
      fl,
      false,
      'off',
      false,
      true,
      await configBool(repo, 'core.quotepath', true),
    )
    const [revisions, paths] = splitMarked(inv.texts, inv.argv)
    const commit = await commitFacts(repo, await resolveCommit(repo, revisionArg(revisions)))
    const pathspecs = pathspecPatterns(repo.location, startPoint(fl).virtual, paths)
    const bodies = await commitOutput(repo, commit, { ...parsed, pathspecs }, fl.asBool('r'), false)
    const out = bodies
      .filter((body) => body !== null)
      .map((body) => (fl.asBool('no_commit_id') ? '' : commit.oid + '\n') + body)
      .join('')
    return [encodeText(out), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
