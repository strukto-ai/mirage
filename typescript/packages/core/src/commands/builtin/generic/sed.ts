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

import { type util } from 'zod'

import { isStdin, stdinStream } from '../utils/stream.ts'
import { StreamHost, hostedStream, ownMount } from '../utils/stream_host.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { resolvePath } from '../../../utils/path.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { SED_MISSING_SCRIPT } from '../constants.ts'
import { byteView, encodeText, utf8Locale } from '../../../shell/bytes.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { openStreamSync } from '../../../rs/stream.ts'

const SED_LINE_LENGTH = 70

// GNU's atoi over -l: leading blanks, a sign, digits. The value stops at the
// largest long and keeps its low 32 bits as an int, so `-l 4294967297` is 1.
// A negative length never folds, the same as 0.
function lineLength(raw: string | undefined): number {
  if (raw === undefined) return SED_LINE_LENGTH
  const m = /^\s*([+-]?)(\d*)/.exec(raw)
  const digits = m?.[2] ?? ''
  if (digits === '' || m?.[1] === '-') return 0
  // Twenty digits already pass the largest long.
  const value = BigInt(digits.replace(/^0+/, '').slice(0, 20) || '0')
  const longMax = (1n << 63n) - 1n
  return Math.max(Number(BigInt.asIntN(32, value > longMax ? longMax : value)), 0)
}

function failed(stderr: string, exitCode: number): CommandFnResult {
  return [null, new IOResult({ exitCode, stderr: encodeText(stderr) })]
}

/**
 * Which -e/-f occurrences of the line were script files, and their names
 * as spelled, for GNU's `file NAME line N:` diagnostics. The executor
 * reads a script file before sed runs and hands its text on as one more
 * -e (so every sub-run of a fanned-out line sees the same program), which
 * leaves only the line's own words to tell the two apart. `null` for an
 * expression; the whole answer is null when the words are not the line's
 * (a split run) or do not account for every occurrence.
 */
function scriptOrigins(
  argv: readonly string[] | undefined,
  count: number,
): (string | null)[] | null {
  if (argv === undefined) return null
  const out: (string | null)[] = []
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? ''
    if (word === '--') break
    if (word.startsWith('--')) {
      if (word === '--line-length') i += 1
      continue
    }
    if (!word.startsWith('-') || word === '-') continue
    for (let j = 1; j < word.length; j++) {
      const c = word.charAt(j)
      if (c !== 'e' && c !== 'f' && c !== 'l') continue
      let value = word.slice(j + 1)
      if (value === '') {
        i += 1
        value = argv[i] ?? ''
      }
      if (c !== 'l') out.push(c === 'f' ? value : null)
      break
    }
  }
  return out.length === count ? out : null
}

interface SedFlags {
  readonly inPlace: boolean
  readonly suppress: boolean
  readonly extended: boolean
  readonly separate: boolean
  readonly lineLength: number
  // -e and -f in the order typed, each with its text.
  readonly scripts: readonly (readonly [string, string])[]
}

function parseFlags(bag: Record<string, FlagValue>): SedFlags {
  const fl = new FlagView(bag, specOf('sed'))
  return {
    inPlace: fl.asBool('i'),
    suppress: fl.asBool('n'),
    extended: fl.asBool('E') || fl.asBool('r'),
    separate: fl.asBool('separate'),
    lineLength: lineLength(fl.asStr('line_length')),
    scripts: fl.occurrences('e', 'f').map(([name, value]) => [name, String(value)] as const),
  }
}

/**
 * Whether a sed line may change files: under `-i`, with a script file (its
 * text is read only when sed runs), or when its script names a `w` file,
 * which GNU opens even when it then refuses the script. `bag` holds the
 * flags as the line's parse reads them; the first of `texts` is the script
 * when no `-e` or `-f` gave one. Mirrors Python's sed_writes.
 */
export function sedWrites(bag: Record<string, FlagValue>, texts: readonly string[]): boolean {
  const fl = new FlagView(bag, specOf('sed'))
  if (fl.asBool('i') || fl.raw('f') !== undefined) return true
  const expressions = fl.asList('e')
  const scripts = expressions.length > 0 ? expressions : texts.slice(0, 1)
  if (scripts.length === 0) return false
  const engine = openStreamSync('sed', {
    pieces: scripts.map((text) => ({ text: byteView(text) })),
    extended: fl.asBool('E') || fl.asBool('r'),
  })
  try {
    return (JSON.parse(new TextDecoder().decode(engine.metadata())) as { writes: boolean }).writes
  } finally {
    engine.close()
  }
}

/**
 * Run sed over the resolved operands, as GNU sed 4.9. The script comes from
 * -e expressions and -f script files, compiled in option order, when any
 * were given, otherwise from the first positional operand. mirage-rs
 * compiles and runs it; every operand and every file the script names is a
 * request the host serves. Mirrors Python's sed_generic.
 */
export async function sedGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(ctx.flags)
  const scriptStream = parsed.inPlace ? stream : stdinStream(stream, ctx.stdin)
  const pieces: Record<string, util.JSONType>[] = []
  const origins = scriptOrigins(ctx.argv, parsed.scripts.length)
  for (const [index, [name, text]] of parsed.scripts.entries()) {
    const shown = origins?.[index] ?? null
    if (name === 'e') {
      pieces.push(
        shown === null ? { text: byteView(text) } : { text: byteView(text), file: byteView(shown) },
      )
      continue
    }
    let body: Uint8Array
    try {
      body = await materialize(scriptStream(PathSpec.fromStrPath(text)))
    } catch (err) {
      if (!isFsError(err)) throw err
      const strerror = fsStrerror(err) ?? posixPhrase('EACCES')
      return failed(`sed: couldn't open file ${shown ?? text}: ${strerror}\n`, 4)
    }
    pieces.push({ text: byteView(body), file: byteView(shown ?? text) })
  }
  if (pieces.length === 0 && texts[0] !== undefined) pieces.push({ text: byteView(texts[0]) })
  if (pieces.length === 0) return failed(`${SED_MISSING_SCRIPT}\n`, 1)
  // -i edits `-` as a file; otherwise an operand naming stdin is `-` to F
  // and to sed's messages.
  const names = paths.map((p) => (!parsed.inPlace && isStdin(p) ? '-' : p.rawPath))
  const config = {
    pieces,
    extended: parsed.extended,
    utf8: utf8Locale(ctx.env),
    quiet: parsed.suppress,
    separate: parsed.separate,
    in_place: parsed.inPlace,
    line_length: parsed.lineLength,
    inputs: names.map((name) => byteView(name)),
    paths: paths.map((p) => byteView(p.virtual)),
    cwd: byteView(ctx.cwd.virtual),
  }
  const host = new StreamHost(paths, stream, ctx, ownMount, !parsed.inPlace)
  const io = new IOResult()
  return [hostedStream('sed', config, host, io, ctx.signal), io]
}

/**
 * When the script is supplied via -e/-f, GNU sed treats every bare argument as
 * a file. The arg parser instead routes the first bare arg into the positional
 * `text` (script) slot, so recover it as a path operand here.
 */
export function positionalAsPaths(texts: string[], ctx: Context): PathSpec[] {
  return texts.map((t) => {
    const resolved = resolvePath(t, ctx.cwd.virtual)
    const slash = resolved.lastIndexOf('/')
    return new PathSpec({
      virtual: resolved,
      directory: slash >= 0 ? resolved.slice(0, slash + 1) : '/',
      resolved: true,
      vfsPath: stripSlash(resolved),
    })
  })
}
