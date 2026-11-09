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

import type { PathSpec } from '../../../types.ts'
import type { GzipDataError } from '../../../utils/compress.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { LinkResolver } from '../utils/links.ts'
import {
  CREATE,
  DIRECTORY,
  HAS_SUFFIX,
  LINK,
  OPEN,
  OUTPUT_EXISTS,
  UNKNOWN_SUFFIX,
  type CompressorFiles,
  type CompressorFlags,
  type Refused,
  type Tool,
  compressFiles,
  lastTyped,
} from './compressor.ts'

// The sizes, keyed as the spec names them.
const LEVELS: Readonly<Record<string, number>> = {
  fast: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  best: 9,
}
const WORDS: Readonly<Record<string, readonly [string, number]>> = {
  [OPEN]: ["{p}: Can't open input file {name}: {why}.", 1],
  [DIRECTORY]: ['{p}: Input file {name} is a directory.', 1],
  [LINK]: ['{p}: Input file {name} is not a normal file.', 1],
  [HAS_SUFFIX]: ['{p}: Input file {name} already has {suffix} suffix.', 1],
  [UNKNOWN_SUFFIX]: ["{p}: Can't guess original name for {name} -- using {name}.out", 0],
  [OUTPUT_EXISTS]: ['{p}: Output file {out} already exists.', 1],
  [CREATE]: ["{p}: Can't create output file {out}: {why}.", 1],
}
const SUFFIXES: readonly (readonly [string, string])[] = [
  ['.bz2', ''],
  ['.bz', ''],
  ['.tbz2', '.tar'],
  ['.tbz', '.tar'],
]
const GUESSED_ENDING = '.out'
const RECOVER_HINT =
  "\nYou can use the `bzip2recover' program to attempt to recover\n" +
  'data from undamaged sections of corrupted files.'
const READS_NOT = 'is not a bzip2 file'
const READS_ENDS = 'ends unexpectedly'
const NOSUCH = 'No such file or directory'
const TTY_WORDS = 'Inappropriate ioctl for device'

/** bzip2's options as `command` reads them; `-z`, `-d` and `-t` are a family
 * where the last typed wins. */
function parseFlags(fl: FlagView, command: string): CompressorFlags {
  const mode = lastTyped(fl, 'compress', 'decompress', 'test')
  const level = lastTyped(fl, ...Object.keys(LEVELS))
  return {
    decompress: mode === 'decompress' || (mode === null && command === 'bunzip2'),
    test: mode === 'test',
    keep: fl.asBool('keep'),
    force: fl.asBool('force'),
    toStdout: fl.asBool('stdout'),
    quiet: fl.asBool('quiet') ? 1 : 0,
    verbose: fl.asInt('verbose') ?? 0,
    level: level === null ? -1 : (LEVELS[level] ?? -1),
    suffix: null,
  }
}

/** bzip2's lines for an input that will not decode. `-t` names what was
 * wrong and goes on; `-d` stops at a broken stream, as it does at anything
 * but an input that is no bzip2 at all. */
function decodeFailed(
  error: GzipDataError,
  program: string,
  name: string,
  out: string | null,
  test: boolean,
): Refused {
  const reason = error.reasons.join('')
  const notBzip2 = reason.includes(READS_NOT)
  const ends = reason.includes(READS_ENDS)
  if (test) {
    const said = notBzip2
      ? 'bad magic number (file not created by bzip2)'
      : ends
        ? 'file ends unexpectedly'
        : 'data integrity (CRC) error in data'
    return { lines: `${program}: ${name}: ${said}\n${RECOVER_HINT}\n\n`, code: 2 }
  }
  if (notBzip2) return { lines: `${program}: ${name} is not a bzip2 file.`, code: 2 }
  const named = reason.replaceAll('({})', name).replaceAll('bzip2:', `${program}:`)
  if (out === null) return { lines: named, code: 2, fatal: true }
  const text = named.replaceAll('(stdout)', out).replaceAll(TTY_WORDS, NOSUCH)
  return {
    lines: `${text}\n${program}: Deleting output file ${out}, if it exists.`,
    code: 2,
    fatal: true,
  }
}

function spaced(name: string, longest: number): string {
  return `  ${name}: ${' '.repeat(longest - name.length)}`
}

/** `bzip2 -v`'s line for an input compressed. */
function summary(name: string, readIn: number, written: number, longest: number): string {
  if (readIn === 0) return `${spaced(name, longest)} no data compressed.`
  const ratio = (readIn / written).toFixed(3).padStart(6)
  const bits = ((written * 8) / readIn).toFixed(3).padStart(6)
  const saved = ((1 - written / readIn) * 100).toFixed(2).padStart(5)
  return (
    `${spaced(name, longest)}${ratio}:1, ${bits} bits/byte, ` +
    `${saved}% saved, ${String(readIn)} in, ${String(written)} out.`
  )
}

/** `bzip2 -v`'s line for an input tested or decompressed. */
function decodedNote(name: string, longest: number, test: boolean): string {
  return `${spaced(name, longest)}${test ? 'ok' : 'done'}`
}

/** Run bzip2 or bunzip2 over resolved operands. Pinned against bzip2 1.0.8. */
export async function bzip2Generic(
  paths: PathSpec[],
  ctx: Context,
  files: CompressorFiles,
  resolver: LinkResolver | null,
  command: string,
): Promise<CommandFnResult> {
  const parsed = parseFlags(new FlagView(ctx.flags, specOf(command)), command)
  const tool: Tool = {
    program: command,
    codec: 'bzip2',
    words: WORDS,
    suffixes: SUFFIXES,
    firstErrorSticks: false,
    decodeFailed,
    silencedAt: { 0: 1 },
    guessedEnding: GUESSED_ENDING,
    summary,
    decodedNote,
  }
  return compressFiles(paths, tool, parsed, files, ctx.stdin, resolver)
}
