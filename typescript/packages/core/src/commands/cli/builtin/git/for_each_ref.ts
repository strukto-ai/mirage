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

import { readStdinAsync } from '../../../builtin/utils/stream.ts'
import type { CommandFnResult } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation } from '../../types.ts'
import { dateClock } from './dates.ts'
import { FormatUsageError, GitError } from './errors.ts'
import { filterWords, refFilter, withoutFilterValues } from './ref_filter.ts'
import { formatRefs, parseFormat, usedFields } from './ref_format.ts'
import { isRootRef, listingResult, matchAsPath, refListing, sortKeys } from './ref_list.ts'
import { opened } from './session.ts'
import { QuoteStyle, RefKind } from './types.ts'
import { checkSwitches, fatal } from './util.ts'

const DEFAULT_FORMAT = '%(objectname) %(objecttype)\t%(refname)'
const QUOTE_OPTIONS: readonly (readonly [string, QuoteStyle])[] = [
  ['shell', QuoteStyle.SHELL],
  ['perl', QuoteStyle.PERL],
  ['python', QuoteStyle.PYTHON],
  ['tcl', QuoteStyle.TCL],
]

/**
 * The one quoting option a line chose, none for plain text.
 *
 * @throws FormatUsageError two of them
 */
function quoteStyle(fl: FlagView): QuoteStyle {
  const chosen = new Set(QUOTE_OPTIONS.filter(([name]) => fl.asBool(name)).map(([, s]) => s))
  if (chosen.size > 1) throw new FormatUsageError('more than one quoting style?')
  return [...chosen][0] ?? QuoteStyle.NONE
}

/**
 * Format the repository's references, as git's ref-filter does: the refs are
 * chosen by the path patterns, `--exclude` and the commit filters, ordered by
 * the `--sort` keys (refname when none), and each is printed through
 * `--format`.
 */
export async function forEachRef(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const words = filterWords(inv)
  const texts = withoutFilterValues(inv.texts, words)
  try {
    checkSwitches(inv, texts)
    const repo = await opened(fl, inv.doors ?? {})
    const filter = await refFilter(repo, words)
    const count = fl.asInt('count') ?? 0
    if (count < 0) throw new FormatUsageError(`invalid --count argument: \`${String(count)}'`)
    const template = fl.asStr('format')
    const fmt = parseFormat(template ?? DEFAULT_FORMAT, quoteStyle(fl))
    const keys = sortKeys(fl, ['refname'])
    const icase = fl.asBool('ignore_case')
    let patterns: readonly string[] = texts
    if (fl.asBool('stdin')) {
      if (texts.length) throw new GitError('unknown arguments supplied with --stdin')
      const data = await readStdinAsync(inv.stdin ?? null)
      const lines = new TextDecoder().decode(data ?? new Uint8Array()).split('\n')
      if (lines.at(-1) === '') lines.pop()
      patterns = lines.map((line) => line.replace(/\r$/, ''))
    }
    const roots = fl.asBool('include_root_refs')
    const excludes = fl.asList('exclude')
    const wanted = (name: string): boolean =>
      (name.startsWith('refs/') || (roots && isRootRef(name))) &&
      matchAsPath(name, patterns, icase) &&
      !(excludes.length && matchAsPath(name, excludes, icase))
    const [listed, ctx, errors] = await refListing(
      repo,
      usedFields(fmt, keys ?? []),
      wanted,
      filter,
      dateClock(inv.env),
      roots,
    )
    const items = roots
      ? listed.map((item) =>
          item.kind === RefKind.DETACHED ? { ...item, kind: RefKind.ROOT } : item,
        )
      : listed
    const [out, stopped] = formatRefs(fmt, items, ctx, keys, {
      count,
      omitEmpty: fl.asBool('omit_empty'),
      icase,
      stream: filter === null || (filter.merged === null && filter.noMerged === null),
    })
    return listingResult(out, errors, stopped)
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
}
