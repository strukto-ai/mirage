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

import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { GitError } from './errors.ts'
import {
  MEDIUM,
  needsDecorations,
  oneline,
  parsePretty,
  presetBlock,
  renderTemplate,
  type CommitFacts,
  type Decorations,
  type LogFormat,
} from './format.ts'
import { decorations, prettyValue } from './history.ts'
import { treeDiff } from './patch.ts'
import { commitFacts, opened, type Repo } from './repo.ts'
import { resolveCommit } from './revparse.ts'
import { diffstat, statTable } from './summary.ts'
import { treeEntries, type TreeEntry } from './tree.ts'
import { checkOperands, fatal, revisionArg } from './util.ts'
import { encodeText } from '../../../../shell/bytes.ts'

const MERGE_PARENTS = 1

// A merge prints no ordinary diff. git renders one against every parent at once
// (`--cc`, the combined format with two prefix columns and `@@@` ranges), which
// comes out empty whenever the merge result matches a parent exactly, so the
// common merge shows only its header. Combined diffs are not implemented, so a
// merge that resolved a conflict shows its header and nothing else rather than a
// patch git would never print.

/**
 * The parsed shape of a `git show` invocation.
 *
 * `--no-ext-diff` is accepted but carries no field: there are no external
 * diff drivers here, so it changes nothing by construction.
 */
interface ShowFlags {
  /** `--stat`, the diffstat table instead of a patch. */
  readonly stat: boolean
  /**
   * `-s`/`--no-patch`, no diff section at all. Wins over `--stat` and
   * `--name-only` in either order, which is what git 2.50 does.
   */
  readonly noPatch: boolean
  /** `--name-only`, changed paths instead of a patch. Wins over `--stat`. */
  readonly nameOnly: boolean
  /** How the header renders. */
  readonly pretty: LogFormat
}

/** Read the raw show flag kwargs into a frozen struct. */
function parseShowFlags(fl: FlagView): ShowFlags {
  const spelled = prettyValue(fl)
  return {
    stat: fl.asBool('stat'),
    noPatch: fl.asBool('no_patch'),
    nameOnly: fl.asBool('name_only'),
    pretty: spelled !== null ? parsePretty(spelled) : MEDIUM,
  }
}

/**
 * The commit header in the requested format.
 *
 * `format:` is a separator, so a single commit prints with no trailing
 * newline at all; `tformat:` terminates the entry even when it renders
 * empty, except that an empty template prints nothing, matching
 * `log --format=`. Pinned against git 2.37 and 2.54.
 */
function header(
  commit: CommitFacts,
  flags: ShowFlags,
  width: number,
  decor: Decorations | null,
): string {
  const fmt = flags.pretty
  if (fmt.kind === 'oneline') return `${oneline(commit, width)}\n`
  if (fmt.kind === 'format' || fmt.kind === 'tformat') {
    const text = renderTemplate(fmt.template ?? '', commit, width, decor)
    if (fmt.kind === 'tformat') {
      return fmt.template === null || fmt.template === '' ? '' : `${text}\n`
    }
    return text
  }
  return `${presetBlock(commit, fmt.kind, width).join('\n')}\n`
}

/** The section under the header: patch, stat, names, or nothing. */
async function diffSection(repo: Repo, commit: CommitFacts, flags: ShowFlags): Promise<string> {
  if (flags.noPatch) return ''
  const first = commit.parents[0]
  const parentTree = first === undefined ? null : (await commitFacts(repo, first)).tree
  if (flags.nameOnly || flags.stat) {
    const before =
      parentTree === null ? new Map<string, TreeEntry>() : await treeEntries(repo, parentTree)
    const after = await treeEntries(repo, commit.tree)
    if (flags.nameOnly) {
      const changed = [...new Set([...before.keys(), ...after.keys()])]
        .filter(
          (path) =>
            before.get(path)?.oid !== after.get(path)?.oid ||
            before.get(path)?.mode !== after.get(path)?.mode,
        )
        .sort()
      return changed.map((path) => `${path}\n`).join('')
    }
    const lines = statTable(await diffstat(repo, before, after))
    return lines.map((line) => `${line}\n`).join('')
  }
  return treeDiff(repo, parentTree, commit.tree)
}

/** Show one commit: its log entry, then its diff against its parent. */
export async function show(inv: CLIInvocation): Promise<CommandFnResult> {
  // The mount doors ride the one record; `opts` keeps its name so
  // the body reads the same as when they were a parameter.
  const opts = inv.ops ?? {}
  const texts = [...inv.texts]
  const fl = new FlagView(inv.flags)
  try {
    checkOperands(texts)
    const parsed = parseShowFlags(fl)
    const repo = await opened(fl, opts.statPath, opts.mountRoot, opts.dispatch)
    const oid = await resolveCommit(repo, revisionArg(texts))
    const facts = await commitFacts(repo, oid)
    const decor = needsDecorations(parsed.pretty) ? await decorations(repo) : null
    const head = header(facts, parsed, repo.abbrev, decor)
    if (facts.parents.length > MERGE_PARENTS) return [encodeText(head), new IOResult()]
    const body = await diffSection(repo, facts, parsed)
    if (body === '') return [encodeText(head), new IOResult()]
    if (head === '') return [encodeText(body), new IOResult()]
    return [encodeText(`${head}\n${body}`), new IOResult()]
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
