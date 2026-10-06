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

import { readStdinAsync, stdinStream } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { eisdir, fsErrorLine, fsStrerror, isFsError } from '../../../utils/errors.ts'
import { dispatchStat } from '../utils/paths.ts'
import { resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { readFailExitCode } from '../../spec/usage.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { FileType, PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { SED_MISSING_SCRIPT, SED_NO_INPUT_EXIT, SED_NO_INPUT_FILES } from '../constants.ts'
import {
  SED_STDERR,
  SED_STDOUT,
  SedError,
  compileScript,
  looksAhead,
  type SedProgram,
  type SedScriptPiece,
} from '../sed_script.ts'
import { SED_LINE_LENGTH, SedMachine, type SedFileContent, type SedInput } from '../sed_exec.ts'
import { byteView, decodeText, encodeText, fromByteView, utf8Locale } from '../../../shell/bytes.ts'

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>
type Write = (p: PathSpec, data: Uint8Array) => Promise<void>

/**
 * How sed reaches the files its script names (`r`, `R`, `w`, `W`,
 * `s///w`): through the workspace dispatcher when there is one, so a name
 * on another mount works as it does for awk's redirections, and through
 * this mount's own read and write otherwise.
 */
interface SedDoors {
  virtual(name: string): string
  read(name: string): Promise<Uint8Array>
  write(name: string, data: Uint8Array): Promise<void>
}

function sedDoors(opts: CommandOpts, stream: Stream, write: Write): SedDoors {
  const prefix = opts.mountPrefix !== undefined ? rstripSlash(opts.mountPrefix) : ''
  const spec = (name: string): PathSpec => {
    const resolved = resolvePath(name, opts.cwd)
    if (opts.dispatch !== undefined) return PathSpec.fromStrPath(name, undefined, opts.cwd)
    const slash = resolved.lastIndexOf('/')
    return new PathSpec({
      virtual: resolved,
      directory: slash >= 0 ? resolved.slice(0, slash + 1) : '/',
      resolved: true,
      vfsPath: mountKey(resolved, prefix),
    })
  }
  const dispatch = opts.dispatch
  return {
    virtual: (name) => resolvePath(name, opts.cwd),
    async read(name) {
      if (dispatch === undefined) return materialize(stream(spec(name)))
      // A keyed store reads a directory as nothing at all, so the stat
      // goes first to fail it the way a POSIX read does.
      const path = spec(name)
      if ((await dispatchStat(dispatch)(path)).type === FileType.DIRECTORY) throw eisdir(path)
      const [data] = await dispatch('read', path)
      return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike)
    },
    async write(name, data) {
      if (dispatch === undefined) {
        await write(spec(name), data)
        return
      }
      await dispatch('write', spec(name), [data])
    },
  }
}

// GNU's atoi over -l: leading blanks, a sign, digits; a negative length
// is a huge unsigned one, which never folds, the same as 0.
function lineLength(raw: string | undefined): number {
  if (raw === undefined) return SED_LINE_LENGTH
  const m = /^\s*([+-]?)(\d*)/.exec(raw)
  const value = Number.parseInt(m?.[2] ?? '', 10)
  if (Number.isNaN(value) || m?.[1] === '-') return 0
  return value
}

function openFailure(name: string, err: unknown): string {
  return `sed: couldn't open file ${name}: ${fsStrerror(err) ?? 'Permission denied'}\n`
}

// Truncate the `w` files as GNU opens them when it compiles the script,
// in order; the first that cannot be opened is GNU's panic.
async function openWriteFiles(names: readonly string[], doors: SedDoors): Promise<string | null> {
  for (const name of names) {
    if (name === SED_STDOUT || name === SED_STDERR) continue
    try {
      await doors.write(name, new Uint8Array())
    } catch (err) {
      if (!isFsError(err)) throw err
      return openFailure(name, err)
    }
  }
  return null
}

// Read the files `r` or `R` names: a file that cannot be opened reads as
// empty, as POSIX asks, and a directory opens and then fails to read,
// which GNU reports and exits 4 on when it gets there. `utf8` reads them as
// text, under a UTF-8 locale.
async function readScriptFiles(
  names: readonly string[],
  doors: SedDoors,
  utf8: boolean,
): Promise<Map<string, SedFileContent>> {
  const files = new Map<string, SedFileContent>()
  for (const name of names) {
    try {
      files.set(name, { text: byteView(await doors.read(name), utf8) })
    } catch (err) {
      if (!isFsError(err)) throw err
      const code = (err as { code?: string }).code
      files.set(
        name,
        code === 'EISDIR' ? { error: `sed: read error on ${name}: Is a directory\n` } : null,
      )
    }
  }
  return files
}

// Write out what the `w` files collected. A `w` file that -i then edited
// keeps the edit: GNU's stream still points at the file -i renamed over.
async function flushWriteFiles(
  machine: SedMachine,
  doors: SedDoors,
  utf8: boolean,
  edited: ReadonlySet<string> = new Set(),
): Promise<string> {
  let err = ''
  for (const [name, out] of machine.wfiles) {
    if (out.chunks.length === 0 || edited.has(doors.virtual(name))) continue
    try {
      await doors.write(name, fromByteView(out.chunks.join(''), utf8))
    } catch (e) {
      if (!isFsError(e)) throw e
      err += openFailure(name, e)
    }
  }
  return err
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

export async function sedGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
  write: Write,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  const inPlace = parsed.inPlace
  if (!inPlace) stream = stdinStream(stream, opts.stdin)
  const pieces: SedScriptPiece[] = []
  const firstPath = paths[0]
  const scriptPrefix =
    (firstPath === undefined ? undefined : mountPrefixOf(firstPath.virtual, firstPath.vfsPath)) ??
    opts.mountPrefix ??
    ''
  const origins = scriptOrigins(opts.argv, parsed.scripts.length)
  for (const [index, [name, text]] of parsed.scripts.entries()) {
    const shown = origins?.[index] ?? null
    if (name === 'e') {
      pieces.push(shown === null ? { kind: 'expr', text } : { kind: 'file', text, name: shown })
      continue
    }
    const spec = PathSpec.fromStrPath(text, mountKey(text, scriptPrefix))
    let body: string
    try {
      body = decodeText(await materialize(stream(spec)))
    } catch (err) {
      if (!isFsError(err)) throw err
      return failed(openFailure(shown ?? text, err), 4)
    }
    pieces.push({ kind: 'file', text: body, name: shown ?? text })
  }
  if (pieces.length === 0 && texts[0] !== undefined) pieces.push({ kind: 'expr', text: texts[0] })
  if (pieces.length === 0) return failed(`${SED_MISSING_SCRIPT}\n`, 1)

  const doors = sedDoors(opts, stream, write)
  const utf8 = utf8Locale(opts.env)
  let program: SedProgram
  try {
    // -E / -r select Extended Regular Expressions; without them sed is BRE.
    program = compileScript(pieces, parsed.extended, utf8)
  } catch (err) {
    if (!(err instanceof SedError)) throw err
    const refused = await openWriteFiles(err.wfiles, doors)
    return failed(refused ?? `${err.message}\n`, refused === null ? err.exitCode : 4)
  }
  const refused = await openWriteFiles(program.wfiles, doors)
  if (refused !== null) return failed(refused, 4)
  const machine = new SedMachine(program, {
    suppress: parsed.suppress,
    separate: inPlace || parsed.separate,
    lineLength: parsed.lineLength,
    files: await readScriptFiles(program.rfiles, doors, utf8),
    readerFiles: await readScriptFiles(program.readerFiles, doors, utf8),
    utf8,
  })

  if (inPlace) return runInPlace(paths, program, machine, doors, stream, write, utf8)

  const inputs: SedInput[] = []
  if (paths.length === 0) {
    const raw = (await readStdinAsync(opts.stdin)) ?? new Uint8Array(0)
    inputs.push({ name: '-', text: byteView(raw, utf8) })
  }
  // sed owns its exit code rather than letting the executor's chokepoint
  // pick it, because GNU sed splits a failed operand two ways (GNU sed
  // 4.9). An OPEN error (a missing file) is exit 2, reported when the run
  // reaches it, and the remaining operands still process: `sed -n p nope
  // ok.txt ok2.txt` prints both files. A READ error (a directory, which
  // opens fine and then fails) is exit 4 and FATAL: `sed -n p dir ok.txt`
  // prints nothing and `sed -n p ok.txt dir ok2.txt` stops after ok.txt.
  // A `q` before an operand means GNU never opens it, so it is not
  // reported either. The operands after a directory are still read: the
  // lookahead for `$` opens a directory, finds no data in it and goes on
  // (`sed -n '$p' ok.txt dir ok2.txt` prints ok2.txt's last line, exit 0).
  // Only `$`, `n` and `N` look ahead, and under -s never into the next
  // file, so otherwise nothing past the directory is read.
  const lookAhead = looksAhead(program) && !parsed.separate
  for (const p of paths) {
    const last = inputs.at(-1)
    if (last !== undefined && 'fatal' in last && last.fatal && !lookAhead) break
    try {
      inputs.push({ name: p.rawPath, text: byteView(await materialize(stream(p)), utf8) })
    } catch (e) {
      if (!isFsError(e)) throw e
      const fatal = (e as { code?: string }).code === 'EISDIR'
      inputs.push({
        name: p.rawPath,
        error: fsErrorLine('sed', p, e),
        code: readFailExitCode('sed', e),
        fatal,
      })
    }
  }
  machine.process(inputs, true)
  const writeErr = await flushWriteFiles(machine, doors, utf8)
  const stderr = machine.stderr() + writeErr
  return [
    fromByteView(machine.stdout.chunks.join(''), utf8),
    new IOResult({
      exitCode: writeErr === '' ? machine.exitCode() : 4,
      stderr: stderr === '' ? null : encodeText(stderr),
    }),
  ]
}

// GNU -i: each file is its own run (line numbers, `$`, the hold space
// and ranges restart) and the whole output of that run replaces the file:
// `p` doubles lines in place, `q` truncates, `a`/`i`/`c` land their text.
// The `w` files, `R` readers and /dev/stdout span the files. A `q` stops
// before the next file; a panic leaves the file it hit untouched.
async function runInPlace(
  paths: PathSpec[],
  program: SedProgram,
  machine: SedMachine,
  doors: SedDoors,
  stream: Stream,
  write: Write,
  utf8: boolean,
): Promise<CommandFnResult> {
  if (paths.length === 0) return failed(`${SED_NO_INPUT_FILES}\n`, SED_NO_INPUT_EXIT)
  const writes: Record<string, Uint8Array> = {}
  const edited: string[] = []
  const editedVirtual = new Set<string>()
  let err = ''
  let code = 0
  for (const p of paths) {
    if (machine.stopped()) break
    let data: Uint8Array
    try {
      data = await materialize(stream(p))
    } catch (e) {
      if (!isFsError(e)) throw e
      err += fsErrorLine('sed', p, e)
      code = Math.max(code, readFailExitCode('sed', e))
      if ((e as { code?: string }).code === 'EISDIR') break
      continue
    }
    // An `r` file edited by an earlier file of this command reads new.
    if (edited.length > 0) machine.setFiles(await readScriptFiles(program.rfiles, doors, utf8))
    const out = machine.process([{ name: p.rawPath, text: byteView(data, utf8) }], false)
    if (machine.panicCode !== null) break
    const newData = fromByteView(out, utf8)
    await write(p, newData)
    writes[p.mountPath] = newData
    edited.push(p.mountPath)
    editedVirtual.add(p.virtual)
  }
  const writeErr = await flushWriteFiles(machine, doors, utf8, editedVirtual)
  const stderr = err + machine.stderr() + writeErr
  const exitCode =
    machine.panicCode ?? (writeErr !== '' ? 4 : code === 4 ? 4 : code || machine.exitCode())
  const stdout = machine.stdout.chunks.join('')
  return [
    stdout === '' ? null : fromByteView(stdout, utf8),
    new IOResult({
      writes,
      cache: edited,
      exitCode,
      stderr: stderr === '' ? null : encodeText(stderr),
    }),
  ]
}

/**
 * When the script is supplied via -e/-f, GNU sed treats every bare argument as
 * a file. The arg parser instead routes the first bare arg into the positional
 * `text` (script) slot, so recover it as a path operand here.
 */
export function positionalAsPaths(texts: string[], opts: CommandOpts): PathSpec[] {
  const prefix = opts.mountPrefix !== undefined ? rstripSlash(opts.mountPrefix) : ''
  return texts.map((t) => {
    const resolved = resolvePath(t, opts.cwd)
    const slash = resolved.lastIndexOf('/')
    return new PathSpec({
      virtual: resolved,
      directory: slash >= 0 ? resolved.slice(0, slash + 1) : '/',
      resolved: true,
      vfsPath: mountKey(resolved, prefix),
    })
  })
}
