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

// Refusal wording and exit codes from Info-ZIP UnZip 6.00 (Info-ZIP
// license; see licenses/third_party/info-zip.txt).

import type { util } from 'zod'
import { specOf } from '../../spec/builtins.ts'
import { OPERAND } from '../../spec/constants.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { versionLine } from '../../spec/standard.ts'
import { UsageError } from '../../errors.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import { byteView } from '../../../shell/bytes.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { extractDest } from './archive/extract.ts'
import { StreamHost, hostedStream } from '../utils/stream_host.ts'

const ENC = new TextEncoder()
// Info-ZIP answers an option it does not know with its usage block and exit
// 10; -1, -2, -s, -m and -h are zipinfo's letters and mean nothing to unzip
// proper (Info-ZIP's `unzip -h` is its help screen).
const USAGE_EXIT = 10
const ZIPINFO_LETTERS = ['1', '2', 's', 'm', 'h'] as const
// The letters mirage-rs reads, by the flag each one is.
const LETTERS: Record<string, string> = {
  l: 'args_l',
  v: 'v',
  t: 't',
  p: 'p',
  Z: 'Z',
  '1': 'args_1',
  '2': '2',
  s: 's',
  m: 'm',
  h: 'h',
  o: 'o',
  n: 'n',
}

// The flags unzip reads, parsed once. Mirrors unzip.py's UnzipFlags.
interface UnzipFlags {
  readonly letters: Readonly<Record<string, boolean>>
  readonly quiet: number
  readonly dest: PathSpec | null
  readonly typed: boolean
  readonly excludes: readonly string[]
}

function parseFlags(fl: FlagView): UnzipFlags {
  return {
    letters: Object.freeze(
      Object.fromEntries(
        Object.entries(LETTERS).map(([letter, flag]) => [letter, fl.asBool(flag)]),
      ),
    ),
    // Only none, -q and -qq differ; mirage-rs takes a byte.
    quiet: Math.min(fl.asInt('q', 0), 2),
    dest: fl.asPath('d') ?? null,
    typed: fl.raw('d') !== undefined,
    excludes: fl.asList('x'),
  }
}

/**
 * The member patterns and the -x patterns, as Info-ZIP reads them: -x takes
 * every operand typed after it, up to a -d, so the operands are placed by
 * where the flag tape recorded them; the first is the archive. A line whose
 * operands the tape does not account for keeps one pattern per -x. Mirrors
 * Python's _patterns.
 */
function patterns(
  fl: FlagView,
  texts: readonly string[],
  excludes: readonly string[],
): [string[], string[]] {
  const tape = fl.occurrences('x', 'd', OPERAND)
  if (tape.filter(([name]) => name === OPERAND).length !== texts.length + 1) {
    return [[...texts], [...excludes]]
  }
  const members: string[] = []
  const excluded: string[] = []
  let listing = false
  let index = -1
  for (const [name, value] of tape) {
    if (name === OPERAND) {
      const word = texts[index]
      if (index >= 0 && word !== undefined) (listing ? excluded : members).push(word)
      index += 1
    } else if (name === 'x' && typeof value === 'string') {
      excluded.push(value)
      listing = true
    } else if (name === 'd') {
      listing = false
    }
  }
  return [members, excluded]
}

/**
 * List, test, pipe or extract an archive through mirage-rs's unzip, which
 * reads it from a host spool and writes each member where -d or the working
 * directory says, on whichever mount owns it. Mirrors unzip.py.
 */
export function unzipGeneric(
  paths: PathSpec[],
  members: readonly string[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  const fl = new FlagView(ctx.flags, specOf('unzip'))
  const flags = parseFlags(fl)
  const { letters, dest } = flags
  const archive = paths[0]
  if (archive === undefined) {
    // Info-ZIP answers -v without an archive with its version banner, and
    // mirage's version line is that banner here.
    if (letters.v === true) return [ENC.encode(versionLine('unzip')), new IOResult()]
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('unzip: missing operand\n') })]
  }
  if (letters.Z !== true) {
    for (const letter of ZIPINFO_LETTERS) {
      if (letters[letter] === true)
        throw new UsageError(`unzip: -${letter} is a ZipInfo option and needs -Z`, USAGE_EXIT)
    }
  }
  const [chosen, excludes] = patterns(fl, members, flags.excludes)
  const config: Record<string, util.JSONType> = {
    archive: byteView(archive.rawPath),
    members: chosen.map((member) => byteView(member)),
    excludes: excludes.map((pattern) => byteView(pattern)),
    base: byteView(rstripSlash(extractDest(dest, ctx.cwd.virtual))),
    q: flags.quiet,
    ...letters,
  }
  if (flags.typed) config.dest = byteView(dest?.rawPath ?? '')
  const host = new StreamHost([archive], stream, ctx, false)
  const io = new IOResult()
  return [hostedStream('unzip', config, host, io, ctx.signal), io]
}
