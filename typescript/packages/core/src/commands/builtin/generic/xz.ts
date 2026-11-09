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

import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { GzipDataError } from '../../../utils/compress.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { quoteText } from '../../quote.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { LinkResolver } from '../utils/links.ts'
import {
  BAD_FORMAT,
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

// The presets, keyed as the spec names them.
const PRESETS: Readonly<Record<string, number>> = {
  fast: 0,
  args_1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  best: 9,
}
const DEFAULT_PRESET = 6
const THREADS = /^[0-9]+(?:[kKmMgG](?:i?B)?)?$/
const CHECKS: ReadonlySet<string> = new Set(['none', 'crc32', 'crc64', 'sha256'])
const FORMATS: ReadonlySet<string> = new Set(['auto', 'xz'])
const MAGIC = Uint8Array.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
const WORDS: Readonly<Record<string, readonly [string, number]>> = {
  [BAD_FORMAT]: ['{p}: {name}: File format not recognized', 1],
  [OPEN]: ['{p}: {name}: {why}', 1],
  [DIRECTORY]: ['{p}: {name}: Is a directory, skipping', 2],
  [LINK]: ['{p}: {name}: Is a symbolic link, skipping', 2],
  [HAS_SUFFIX]: ["{p}: {name}: File already has '{suffix}' suffix, skipping", 2],
  [UNKNOWN_SUFFIX]: ['{p}: {name}: Filename has an unknown suffix, skipping', 2],
  [OUTPUT_EXISTS]: ['{p}: {out}: File exists', 1],
  [CREATE]: ['{p}: {out}: {why}', 1],
}
const SUFFIXES: readonly (readonly [string, string])[] = [
  ['.xz', ''],
  ['.txz', '.tar'],
  ['.lzma', ''],
  ['.tlz', '.tar'],
]

/** xz's options as `command` reads them; `-z`, `-d` and `-t` are a family
 * where the last typed wins. A value xz refuses answers its line. */
function parseFlags(fl: FlagView, command: string): CompressorFlags | [string, number] {
  const checks: readonly [string, ReadonlySet<string> | null, string][] = [
    ['threads', null, 'Value is not a non-negative decimal integer'],
    ['check', CHECKS, 'Unsupported integrity check type'],
    ['format', FORMATS, 'Unknown file format type'],
  ]
  for (const [name, valid, why] of checks) {
    const given = fl.asStr(name)
    if (given === undefined) continue
    const good = valid === null ? THREADS.test(given) : valid.has(given)
    if (!good) return [`${command}: ${quoteText(given)}: ${why}`, 1]
  }
  const suffix = fl.asStr('suffix') ?? null
  if (suffix !== null && (suffix === '' || suffix.includes('/')))
    return [`${command}: ${quoteText(suffix)}: Invalid filename suffix`, 1]
  const mode = lastTyped(fl, 'compress', 'decompress', 'test')
  const preset = lastTyped(fl, ...Object.keys(PRESETS))
  return {
    decompress: mode === 'decompress' || (mode === null && command === 'unxz'),
    test: mode === 'test',
    keep: fl.asBool('keep'),
    force: fl.asBool('force'),
    toStdout: fl.asBool('stdout'),
    quiet: fl.asInt('quiet') ?? 0,
    verbose: fl.asInt('verbose') ?? 0,
    level: preset === null ? DEFAULT_PRESET : (PRESETS[preset] ?? DEFAULT_PRESET),
    suffix,
  }
}

/** xz's line for an input that will not decode: the name typed in place of
 * the stream's stand-in, and on to the next input. */
function decodeFailed(error: GzipDataError, program: string, name: string): Refused {
  const text = error.reasons.map((reason) => reason.replaceAll('({})', name)).join('')
  return { lines: program + (text.startsWith('xz') ? text.slice(2) : text), code: 1 }
}

/** Run xz or unxz over resolved operands. Pinned against xz 5.8.1. */
export async function xzGeneric(
  paths: PathSpec[],
  ctx: Context,
  files: CompressorFiles,
  resolver: LinkResolver | null,
  command: string,
): Promise<CommandFnResult> {
  const parsed = parseFlags(new FlagView(ctx.flags, specOf(command)), command)
  if (Array.isArray(parsed)) {
    const [line, code] = parsed
    return [null, new IOResult({ exitCode: code, stderr: new TextEncoder().encode(`${line}\n`) })]
  }
  const tool: Tool = {
    program: command,
    codec: 'xz',
    words: WORDS,
    suffixes: SUFFIXES,
    firstErrorSticks: true,
    decodeFailed,
    silencedAt: { 1: 2, 2: 1 },
    magic: MAGIC,
  }
  return compressFiles(paths, tool, parsed, files, ctx.stdin, resolver)
}
