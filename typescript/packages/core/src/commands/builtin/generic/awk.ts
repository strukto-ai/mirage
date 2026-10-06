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

import { byteView, decodeText, fromByteView, textView } from '../../../shell/bytes.ts'
import { isStdin, resolveSource } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec, FileType } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { chunks } from '../../../io/cooperative.ts'
import {
  AwkIOError,
  AwkRuntimeError,
  AwkSyntaxError,
  ExitProgram,
  Interpreter,
  parse,
  text,
  unescape,
  type AwkHost,
  type CommandRun,
} from '../../../core/awk/index.ts'
import { USAGE, type AwkFlags } from './awk_types.ts'
import { dispatchStat } from '../utils/paths.ts'

import {
  eisdir,
  fsStrerror,
  isEnotdir,
  isFsError,
  isMissingPath,
  isWalkError,
} from '../../../errors/fs.ts'
import { shellJoin } from '../../../shell/join.ts'
import { posixPhrase } from '../../../errors/posix.ts'

const ENC = new TextEncoder()

const STDIN_NAMES: ReadonlySet<string> = new Set(['-', '/dev/stdin'])

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

function parseFlags(opts: CommandOpts): AwkFlags {
  const fl = new FlagView(opts.flags, specOf('awk'))
  const assignments = fl.asList('v')
  const programFiles = fl.asPaths('f')
  return {
    fieldSeparator: fl.asStr('F') ?? null,
    assignments,
    programFiles,
  }
}

function splitAssignments(raw: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of raw) {
    const eq = item.indexOf('=')
    if (eq >= 0) out[item.slice(0, eq)] = unescape(byteView(item.slice(eq + 1)))
  }
  return out
}

function exitStatus(code: number): number {
  return Number(BigInt.asUintN(8, BigInt(code)))
}

function isFatal(err: unknown): err is AwkRuntimeError | AwkSyntaxError {
  return err instanceof AwkRuntimeError || err instanceof AwkSyntaxError
}

/**
 * Whether the mount awk runs on serves an operand. A line whose operands span
 * mounts runs awk once, on its first file's mount; an operand another mount
 * serves is read through the dispatcher. Outside a workspace (no name plane)
 * every operand is the mount's own.
 */
export function servedHere(opts: CommandOpts, path: PathSpec): boolean {
  const mounts = opts.ns?.mounts
  if (mounts === undefined) return true
  const home = (opts.mountPrefix ?? '').replace(/\/+$/, '')
  return mounts.rootOf(path.virtual).replace(/\/+$/, '') === home
}

/** Relay a stream, a filesystem failure becoming awk's `AwkIOError`. */
async function* guarded(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  try {
    yield* chunks(source)
  } catch (err) {
    if (!isFsError(err)) throw err
    throw new AwkIOError(fsStrerror(err) ?? posixPhrase('ENOENT'))
  }
}

/**
 * The files and commands one awk run reaches, through the workspace.
 * Operands still holding their command-line value read through the
 * mount's own reader, the way they were resolved, unless another mount
 * serves them (a line spanning mounts); every other name
 * (`getline < file`, an ARGV slot the program filled) reads through the
 * dispatcher, as output redirection writes through it. Every stdin
 * reader, a `-` operand, `getline < "-"` and a command's inherited input
 * alike, shares one cursor, so none replays what another read.
 */
export class AwkStreams implements AwkHost {
  private readonly operands: readonly PathSpec[]
  private readonly stream: Stream
  private readonly stdin: AsyncIterator<Uint8Array>
  private readonly opts: CommandOpts

  constructor(operands: readonly PathSpec[], stream: Stream, opts: CommandOpts) {
    this.operands = operands
    this.stream = stream
    this.stdin = resolveSource(opts.stdin)[Symbol.asyncIterator]()
    this.opts = opts
  }

  private async *stdinView(): AsyncIterable<Uint8Array> {
    for (;;) {
      const next = await this.stdin.next()
      if (next.done === true) return
      yield next.value
    }
  }

  private async *readPath(name: string | PathSpec): AsyncIterable<Uint8Array> {
    const dispatch = this.opts.dispatch
    if (dispatch === undefined) throw new AwkIOError(posixPhrase('ENOENT'))
    const path = PathSpec.fromStrPath(name, undefined, this.opts.cwd)
    // A keyed store reads a directory as nothing at all, and other backends
    // fail it in their own words, so the stat goes first to fail it the way
    // a POSIX read does.
    if ((await dispatchStat(dispatch)(path)).type === FileType.DIRECTORY) throw eisdir(path)
    const [data] = await dispatch('read', path)
    yield data instanceof Uint8Array ? data : ENC.encode(String(data))
  }

  /** A `-f` program file: /dev/stdin reads the shared stdin cursor. */
  programSource(path: PathSpec): AsyncIterable<Uint8Array> {
    return isStdin(path) ? this.stdinView() : this.stream(path)
  }

  openInput(name: string, index: number | null): AsyncIterable<Uint8Array> {
    name = textView(name)
    if (index !== null && index > 0 && index <= this.operands.length) {
      const operand = this.operands[index - 1]
      if (operand?.rawPath === name) {
        if (isStdin(operand)) return guarded(this.stdinView())
        if (servedHere(this.opts, operand)) return guarded(this.stream(operand))
        return guarded(this.readPath(operand))
      }
    }
    if (STDIN_NAMES.has(name)) return guarded(this.stdinView())
    return guarded(this.readPath(name))
  }

  async writeFile(name: string, body: string, append: boolean): Promise<void> {
    const dispatch = this.opts.dispatch
    if (dispatch === undefined) throw new AwkRuntimeError('awk: file output requires a workspace')
    const path = PathSpec.fromStrPath(textView(name), undefined, this.opts.cwd)
    try {
      await dispatch(append ? 'append' : 'write', path, [fromByteView(body)])
    } catch (error) {
      if (!isWalkError(error)) throw error
      throw new AwkIOError(fsStrerror(error) ?? 'Cannot write output file')
    }
  }

  /**
   * Run a command line in a subshell of the session, as sh -c would.
   * `eval` takes the line whole, so an empty one, a comment or a line
   * ending in a backslash runs as `sh -c` would run it.
   */
  async run(command: string, stdin: Uint8Array | null): Promise<CommandRun> {
    const shell = this.opts.shell
    if (shell === undefined) {
      throw new AwkRuntimeError('awk: running a command requires a workspace')
    }
    const source: ByteSource = stdin ?? this.stdinView()
    const io = await shell(`( ${shellJoin(['eval', textView(command)])} )`, source)
    const stdout = await materialize(io.stdout)
    const stderr = await materialize(io.stderr)
    return { stdout, stderr, status: io.exitCode }
  }
}

/** Run one phase of the program; true when it ran `exit`. */
async function stage(step: Promise<void>, io: IOResult): Promise<boolean> {
  try {
    await step
  } catch (err) {
    if (!(err instanceof ExitProgram)) throw err
    io.exitCode = exitStatus(err.code)
    return true
  }
  return false
}

function addStderr(io: IOResult, err: Uint8Array): void {
  if (err.length === 0) return
  const held = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
  const joined = new Uint8Array(held.length + err.length)
  joined.set(held)
  joined.set(err, held.length)
  io.stderr = joined
}

async function drained(interp: Interpreter, io: IOResult): Promise<Uint8Array> {
  const [out, err] = await interp.drain()
  addStderr(io, err)
  return out
}

/**
 * Run the program, yielding standard output as each record settles.
 * `exit` in BEGIN skips the input and in the main rules stops it, and END
 * runs after either; every awk treats a runtime error as fatal at exit 2
 * and keeps what it had already written.
 */
async function* awkStream(interp: Interpreter, io: IOResult): AsyncIterable<Uint8Array> {
  try {
    const exited = await stage(interp.runBegin(), io)
    yield await drained(interp, io)
    if (!exited && interp.hasMainRules()) {
      for (;;) {
        const record = await interp.nextRecord()
        if (record === null) break
        if (await stage(interp.runRecord(record), io)) break
        const chunk = await drained(interp, io)
        if (chunk.length > 0) yield chunk
      }
    }
    await stage(interp.runEnd(), io)
    await interp.finish()
    yield await drained(interp, io)
  } catch (err) {
    if (!isFatal(err)) throw err
    const [out, stderr] = await interp.salvage(err)
    io.exitCode = 2
    addStderr(io, stderr)
    yield out
  } finally {
    await interp.closeInputs()
  }
}

export async function awkGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  const f = parseFlags(opts)
  const streams = new AwkStreams(paths, stream, opts)
  let program: string
  if (f.programFiles.length > 0) {
    const pieces: string[] = []
    for (const programFile of f.programFiles) {
      try {
        pieces.push(decodeText(await materialize(streams.programSource(programFile))))
      } catch (err) {
        // GNU awk exits 2 when a -f program file cannot be opened;
        // anything that is not absence keeps propagating.
        if (!isMissingPath(err) && !isEnotdir(err)) throw err
        const msg = `awk: ${programFile.rawPath}: ${fsStrerror(err) ?? posixPhrase('ENOENT')}`
        return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
      }
    }
    program = pieces.join('\n')
  } else if (texts.length > 0 && texts[0] !== undefined) {
    program = texts[0]
  } else {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${USAGE}\n`) })]
  }

  let parsed
  try {
    parsed = parse(program)
  } catch (err) {
    if (!(err instanceof AwkSyntaxError)) throw err
    return [null, new IOResult({ exitCode: 2, stderr: fromByteView(`${err.message}\n`) })]
  }
  // An empty operand names no file and mawk skips it, as it does an
  // operand ARGV no longer holds; a `var=value` operand is assigned when
  // the input reaches it. FILENAME reports the operand as typed.
  const interp = new Interpreter(
    parsed,
    streams,
    paths.map((p) => byteView(p.rawPath)),
    splitAssignments(f.assignments),
    Object.fromEntries(
      Object.entries(opts.env ?? {}).map(([name, value]) => [byteView(name), byteView(value)]),
    ),
  )
  if (f.fieldSeparator !== null) interp.setVar('FS', text(unescape(byteView(f.fieldSeparator))))

  const io = new IOResult()
  return [awkStream(interp, io), io]
}
