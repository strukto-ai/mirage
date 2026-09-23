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

import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { prefixAggregate } from '@struktoai/mirage-core/commands/builtin/aggregators'
import { grepGeneric } from '@struktoai/mirage-core/commands/builtin/generic/grep'
import { resolveGlobOf } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import { compilePattern, patternArg } from '@struktoai/mirage-core/commands/builtin/grep_pattern'
import {
  pushdownOperand,
  searchQuery,
  textSearchResults,
} from '@struktoai/mirage-core/commands/builtin/grep_pushdown'
import { grepLines } from '@struktoai/mirage-core/commands/builtin/grep_scan'
import type { GrepLinesOptions } from '@struktoai/mirage-core/commands/builtin/grep_scan'
import { FlagView, specOf } from '@struktoai/mirage-core/commands/spec/index'
import { command } from '@struktoai/mirage-core/commands/config'
import type { CommandFnResult, CommandOpts } from '@struktoai/mirage-core/commands/config'
import { IOResult } from '@struktoai/mirage-core/io/types'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { VFSName } from '@struktoai/mirage-core/types'
import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import type { EmailAccessor } from '../../../accessor/email.ts'
import { read as emailRead } from '../../../core/email/read.ts'
import { readdir as emailReaddir } from '../../../core/email/readdir.ts'
import { stat as emailStat } from '../../../core/email/stat.ts'
import { detectScope, NATIVE_KINDS } from '../../../core/email/scope.ts'
import { searchAndFormat } from '../../../core/email/search.ts'
import { EMAIL_IO } from './io.ts'
import { fileReadProvision } from './_provision.ts'

const resolveGlob = resolveGlobOf(EMAIL_IO)

const ENC = new TextEncoder()

// The email push-down is not a "print the provider's answer" push-down: IMAP
// search only picks the candidate messages, and `grepLines` then runs the
// real compiled pattern over each one. So the rule for honoring a flag is
// whether it can make a message the search did NOT return contribute output.
// -n/-l/-w/-o/-m cannot: each only narrows within a message already listed,
// and -m is per-file here, which is GNU's own reading of it. -v and -c both
// can, and were wrong before this: -v reports the lines that do not match, so
// it needs every message rather than the ones containing the pattern, and
// GNU's -c prints a `path:0` row for the files with no match at all. They
// defer now, along with -q, -H/-h, -A/-B/-C, rg's -I and the file filters.
export const SEARCH_HONORED = ['n', 'args_l', 'w', 'o', 'm'] as const

// Messages are greped line by line, as python's `splitlines()` does; passing
// the whole message as one line made -n report 1 for every hit and printed
// the entire message as the matching line.
export function messageLines(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

async function* emailStream(
  accessor: EmailAccessor,
  p: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await emailRead(accessor, p, index)
}

async function grepCommand(
  accessor: EmailAccessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const pattern = patternArg(texts, opts.flags)
  const fl = new FlagView(opts.flags, specOf('grep'))

  // A directory operand is only searched at all under -r/-R, so the push-down
  // waits for it too; every other reason to defer is the shared gate's. A
  // scope that names no folder falls through to the generic scan rather than
  // answering, which is what the mount root does.
  const operand = pushdownOperand(paths, opts.flags, pattern, SEARCH_HONORED)
  // IMAP TEXT is a case-insensitive substring search, not a regex engine,
  // so the server is asked for the literal every match must contain and
  // the real pattern runs over each candidate. A pattern with no such
  // literal (an alternation, a class with nothing required around it)
  // takes the generic scan rather than a search for the regex's spelling.
  // grep reads a basic expression unless -E says otherwise, and the
  // literal has to be read off the same dialect the matcher will use.
  const basic = !fl.asBool('E')
  const query = pattern !== null ? searchQuery(pattern, fl.asBool('F'), basic) : null
  if (
    pattern !== null &&
    query !== null &&
    operand !== null &&
    (fl.asBool('r') || fl.asBool('R'))
  ) {
    const match = detectScope(operand)
    if (NATIVE_KINDS.has(match.kind)) {
      const filePrefix = mountPrefixOf(operand.virtual, operand.vfsPath)
      const pairs = await searchAndFormat(
        accessor,
        match.slots.folder ?? '',
        query,
        filePrefix,
        accessor.config.maxMessages,
      )
      if (textSearchResults(pairs.map(([, text]) => text))) {
        // The same dialect the literal was read off: a basic expression
        // compiled as an extended one matches a different language.
        const pat = compilePattern(pattern, fl.asBool('i'), fl.asBool('F'), fl.asBool('w'), basic)
        const lineOpts: GrepLinesOptions = {
          invert: false,
          lineNumbers: fl.asBool('n'),
          countOnly: false,
          filesOnly: fl.asBool('args_l'),
          onlyMatching: fl.asBool('o'),
          maxCount: fl.asInt('m') ?? null,
        }
        const lines: string[] = []
        for (const [vfsPath, msgText] of pairs) {
          const matched = grepLines(vfsPath, messageLines(msgText), pat, lineOpts)
          if (matched.length === 0) continue
          if (lineOpts.filesOnly) {
            lines.push(vfsPath)
            continue
          }
          for (const line of matched) lines.push(`${vfsPath}:${line}`)
        }
        if (lines.length === 0) return [new Uint8Array(0), new IOResult({ exitCode: 1 })]
        const out: ByteSource = ENC.encode(lines.join('\n') + '\n')
        return [out, new IOResult()]
      }
    }
  }

  const resolved =
    paths.length > 0 ? await resolveGlob(accessor, paths, opts.index ?? undefined) : []
  const stat = (p: PathSpec): Promise<FileStat> => emailStat(accessor, p, opts.index ?? undefined)
  const readdir = (p: PathSpec): Promise<string[]> =>
    emailReaddir(accessor, p, opts.index ?? undefined)
  return grepGeneric('grep', resolved, texts, opts, stat, readdir, (p) =>
    emailStream(accessor, p, opts.index ?? undefined),
  )
}

export const EMAIL_GREP = command({
  name: 'grep',
  vfs: VFSName.EMAIL,
  spec: specOf('grep'),
  fn: grepCommand,
  aggregate: prefixAggregate,
  provision: fileReadProvision,
})
