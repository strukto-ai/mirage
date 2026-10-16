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

import { ByteWriter } from '../../../io/writer.ts'
import { concat } from '../../../utils/bytes.ts'

import { isStdin, stdinStream } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { fsStrerror, isFsError, isStaleWrite } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { callerStream } from '../generic_bind/dispatch.ts'
import { currentCaller } from '../../../context/session_context.ts'
import { resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { readFailExitCode } from '../../spec/usage.ts'
import { closeQuietly, ensureStream, primeStream } from '../../../io/stream.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { SED_MISSING_SCRIPT, SED_NO_INPUT_EXIT, SED_NO_INPUT_FILES } from '../constants.ts'
import {
  SED_STDERR,
  SED_STDOUT,
  SedError,
  compileScript,
  type SedProgram,
  type SedScriptPiece,
} from '../sed_script.ts'
import { SED_LINE_LENGTH, SedMachine, type SedFileContent, type SedInput } from '../sed_exec.ts'
import { byteView, decodeText, encodeText, fromByteView, utf8Locale } from '../../../shell/bytes.ts'
import { posixPhrase } from '../../../errors/posix.ts'

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>
type Write = (p: PathSpec, data: Uint8Array) => Promise<void>

/**
 * How sed reaches the files its script names (`r`, `R`, `w`, `W`,
 * `s///w`): through the workspace dispatcher when there is one, so a name
 * on another mount works as it does for awk's redirections, and through
 * this mount's own read and write otherwise.
 */
interface ScriptFiles {
  virtual(name: string): string
  read(name: string): Promise<Uint8Array>
  stream(name: string): AsyncIterable<Uint8Array>
  write(name: string, data: ByteSource, atomic?: boolean, append?: boolean): Promise<void>
}

function scriptFiles(opts: CommandOpts, stream: Stream, write: Write): ScriptFiles {
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
  const caller = currentCaller()
  const open = (name: string): AsyncIterable<Uint8Array> =>
    dispatch === undefined ? stream(spec(name)) : callerStream(dispatch, caller, spec(name))
  const access: ScriptFiles = {
    virtual: (name) => resolvePath(name, opts.cwd),
    read: (name) => materialize(open(name)),
    stream: open,
    async write(name, data, atomic = false, append = false) {
      if (dispatch === undefined) {
        const previous = append ? await materialize(open(name)) : new Uint8Array()
        const next = await materialize(data)
        const combined = new Uint8Array(previous.length + next.length)
        combined.set(previous)
        combined.set(next, previous.length)
        await write(spec(name), combined)
        return
      }
      await dispatch(append ? 'append' : 'write', spec(name), [data], atomic ? { atomic } : {})
    },
  }
  return access
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
  return `sed: couldn't open file ${name}: ${fsStrerror(err) ?? posixPhrase('EACCES')}\n`
}

function editFailure(name: string, err: unknown): string {
  return `sed: couldn't edit ${name}: ${fsStrerror(err) ?? String(err)}\n`
}

// Truncate the `w` files as GNU opens them when it compiles the script,
// in order; the first that cannot be opened is GNU's panic.
async function openWriteFiles(
  names: readonly string[],
  access: ScriptFiles,
): Promise<string | null> {
  for (const name of names) {
    if (name === SED_STDOUT || name === SED_STDERR) continue
    try {
      await access.write(name, new Uint8Array())
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
  access: ScriptFiles,
  utf8: boolean,
  streamed = false,
): Promise<Map<string, SedFileContent>> {
  const files = new Map<string, SedFileContent>()
  for (const name of names) {
    if (streamed) {
      files.set(name, { read: () => access.stream(name) })
      continue
    }
    try {
      files.set(name, { text: byteView(await access.read(name), utf8) })
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

/**
 * Drain sed's named outputs, one bounded writer per file for the run. A writer
 * stays open until the run ends: finishing one at each switch between files
 * would make every switch an append, which a store without native appends
 * rewrites whole. A `w` file that -i then edited keeps the edit: GNU's stream
 * still points at the file -i renamed over. GNU opens each spelling of a file
 * (`w out`, `w ./out`) as its own buffered stream from offset 0, and the first
 * opened is flushed last: its bytes win, and a later spelling's show only past
 * its end. The first spelling writes here; the others keep only the bytes past
 * what it has written so far, for that tail. Mirrors Python's `_ScriptWrites`.
 */
class ScriptWrites {
  private writers = new Map<string, ByteWriter>()
  private readonly failedNames = new Set<string>()
  readonly edited = new Set<string>()
  errors = ''

  private readonly first = new Map<string, string>()
  private readonly later = new Map<string, { dropped: number; bytes: Uint8Array }>()
  private readonly sent = new Map<string, number>()

  constructor(
    private readonly machine: SedMachine,
    private readonly access: ScriptFiles,
    private readonly utf8: boolean,
    private readonly defer: boolean,
  ) {
    for (const name of machine.wfiles.keys()) {
      const path = access.virtual(name)
      if (!this.first.has(path)) this.first.set(path, name)
      else this.later.set(name, { dropped: 0, bytes: new Uint8Array() })
    }
  }

  async flush(final = false): Promise<void> {
    if (this.defer && !final) return
    for (const [name, out] of this.machine.wfiles) {
      if (out.chunks.length === 0) continue
      const data = fromByteView(out.chunks.join(''), this.utf8)
      out.chunks.length = 0
      if (this.failedNames.has(name) || this.edited.has(this.access.virtual(name))) continue
      const kept = this.later.get(name)
      if (kept !== undefined) this.keep(kept, this.access.virtual(name), data)
      else await this.send(name, data)
    }
  }

  private keep(kept: { dropped: number; bytes: Uint8Array }, path: string, data: Uint8Array): void {
    const bytes = concat([kept.bytes, data])
    const sent = this.sent.get(this.first.get(path) ?? '') ?? 0
    const covered = Math.min(sent - kept.dropped, bytes.byteLength)
    kept.bytes = covered > 0 ? bytes.slice(covered) : bytes
    kept.dropped += Math.max(covered, 0)
  }

  private async send(name: string, data: Uint8Array): Promise<void> {
    let writer = this.writers.get(name)
    if (writer === undefined) {
      writer = new ByteWriter((source) => this.access.write(name, source, false, true))
      this.writers.set(name, writer)
    }
    try {
      await writer.write(data)
      this.sent.set(name, (this.sent.get(name) ?? 0) + data.byteLength)
    } catch (error) {
      if (!isFsError(error)) throw error
      this.failed(name, error)
      this.writers.delete(name)
      await writer.abort()
    }
  }

  async finish(): Promise<void> {
    const tails = new Map<string, Uint8Array>()
    for (const [name, kept] of [...this.later].reverse()) {
      const path = this.access.virtual(name)
      const sent = this.sent.get(this.first.get(path) ?? '') ?? 0
      const piece = kept.bytes.subarray(sent - kept.dropped)
      const tail = tails.get(path) ?? new Uint8Array()
      tails.set(
        path,
        piece.byteLength >= tail.byteLength
          ? piece
          : concat([piece, tail.subarray(piece.byteLength)]),
      )
    }
    for (const [path, tail] of tails) {
      const first = this.first.get(path) ?? ''
      if (tail.byteLength > 0 && !this.failedNames.has(first) && !this.edited.has(path)) {
        await this.send(first, tail)
      }
    }
    const writers = this.writers
    this.writers = new Map()
    for (const [name, writer] of writers) {
      try {
        await writer.finish()
      } catch (error) {
        if (!isFsError(error)) throw error
        this.failed(name, error)
      }
    }
  }

  async abort(): Promise<void> {
    const writers = this.writers
    this.writers = new Map()
    for (const writer of writers.values()) await writer.abort()
  }

  private failed(name: string, error: unknown): void {
    this.failedNames.add(name)
    this.errors += openFailure(name, error)
  }
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

  const access = scriptFiles(opts, stream, write)
  const utf8 = utf8Locale(opts.env)
  let program: SedProgram
  try {
    // -E / -r select Extended Regular Expressions; without them sed is BRE.
    program = compileScript(pieces, parsed.extended, utf8)
  } catch (err) {
    if (!(err instanceof SedError)) throw err
    const refused = await openWriteFiles(err.wfiles, access)
    return failed(refused ?? `${err.message}\n`, refused === null ? err.exitCode : 4)
  }
  const refused = await openWriteFiles(program.wfiles, access)
  if (refused !== null) return failed(refused, 4)
  const machine = new SedMachine(program, {
    suppress: parsed.suppress,
    separate: inPlace || parsed.separate,
    lineLength: parsed.lineLength,
    files: await readScriptFiles(program.rfiles, access, utf8, !parsed.inPlace),
    readerFiles: await readScriptFiles(
      program.readerFiles,
      access,
      utf8,
      !(parsed.inPlace || parsed.separate),
    ),
    utf8,
  })

  const writes = new ScriptWrites(
    machine,
    access,
    utf8,
    inPlace || program.rfiles.length > 0 || program.readerFiles.length > 0,
  )
  if (inPlace) {
    try {
      return await runInPlace(paths, program, machine, access, stream, utf8, writes, opts.signal)
    } finally {
      await writes.abort()
    }
  }

  const stdinSource = ensureStream(opts.stdin ?? new Uint8Array())
  const inputs: SedInput[] = paths.map((p) =>
    isStdin(p) ? { name: '-', source: stdinSource } : { name: p.rawPath, source: stream(p) },
  )
  if (inputs.length === 0) inputs.push({ name: '-', source: stdinSource })
  const io = new IOResult()
  async function* output(): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of machine.process(inputs, true, opts.signal, () => writes.flush()))
        yield fromByteView(chunk, utf8)
    } finally {
      try {
        await writes.flush(true)
        await writes.finish()
      } finally {
        await writes.abort()
      }
      const writeErr = writes.errors
      const stderr = machine.stderr() + writeErr
      io.exitCode = writeErr === '' ? machine.exitCode() : 4
      io.stderr = stderr === '' ? null : encodeText(stderr)
    }
  }
  return [output(), io]
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
  access: ScriptFiles,
  stream: Stream,
  utf8: boolean,
  writes: ScriptWrites,
  signal?: AbortSignal,
): Promise<CommandFnResult> {
  if (paths.length === 0) return failed(`${SED_NO_INPUT_FILES}\n`, SED_NO_INPUT_EXIT)
  const editedVirtual = new Set<string>()
  let err = ''
  let code = 0
  for (const p of paths) {
    if (machine.stopped()) break
    let data: ByteSource
    try {
      data = await primeStream(stream(p))
    } catch (e) {
      if (!isFsError(e)) throw e
      err += fsErrorLine('sed', p, e)
      code = Math.max(code, readFailExitCode('sed', e))
      if ((e as { code?: string }).code === 'EISDIR') break
      continue
    }
    try {
      // An `r` file edited by an earlier file of this command reads new.
      if (editedVirtual.size > 0)
        machine.setFiles(await readScriptFiles(program.rfiles, access, utf8))
      try {
        writes.edited.add(access.virtual(p.virtual))
        await access.write(p.virtual, editOutput(machine, p, data, utf8, writes, signal), true)
      } catch (e) {
        if (e instanceof EditAborted) break
        if (!isStaleWrite(e)) throw e
        err += editFailure(p.rawPath, e)
        code = 4
        break
      }
    } finally {
      await closeQuietly(data)
    }
    editedVirtual.add(p.virtual)
  }
  await writes.flush(true)
  await writes.finish()
  const writeErr = writes.errors
  const stderr = err + machine.stderr() + writeErr
  const exitCode =
    machine.panicCode ?? (writeErr !== '' ? 4 : code === 4 ? 4 : code || machine.exitCode())
  const stdout = machine.stdout.chunks.join('')
  return [
    stdout === '' ? null : fromByteView(stdout, utf8),
    new IOResult({ exitCode, stderr: stderr === '' ? null : encodeText(stderr) }),
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

class EditAborted extends Error {}

async function* editOutput(
  machine: SedMachine,
  path: PathSpec,
  source: ByteSource,
  utf8: boolean,
  writes: ScriptWrites,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of machine.process([{ name: path.rawPath, source }], false, signal, () =>
    writes.flush(),
  )) {
    yield fromByteView(chunk, utf8)
  }
  if (machine.panicCode !== null) throw new EditAborted()
}
