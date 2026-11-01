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

// The program file and the exit statuses follow jq 1.8.2's src/main.c (MIT;
// see licenses/third_party/jq.txt).

import { specOf } from '../../spec/builtins.ts'
import { OPERAND, REFUSED } from '../../spec/constants.ts'
import { FlagView, specFlagNames } from '../../spec/flag_view.ts'
import { STDIN_NAME, localZone } from '../../../core/jq/index.ts'
import { COMPILE_REPORT } from '../../../core/jq/eval.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused } from '../../../rs/scan.ts'
import {
  closeStream,
  openStream,
  serveRequests,
  type OpenStream,
  type Served,
} from '../../../rs/stream.ts'
import { MemoryExhausted } from '../../../io/errors.ts'
import { memoryRoom } from '../../../io/memory.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { chunks } from '../../../io/cooperative.ts'
import { closeQuietly } from '../../../io/stream.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec, type JsonValue } from '../../../types.ts'
import { fsStrerror, isEisdir, isFsError } from '../../../errors/fs.ts'
import { byteView } from '../../../shell/bytes.ts'
import { parent } from '../../../utils/path.ts'
import { type CommandFnResult, type Context } from '../../config.ts'
import { helpPage, versionLine } from '../../spec/standard.ts'
import type { FlagValue } from '../../spec/types.ts'
import { isStdin, stdinStream } from '../utils/stream.ts'
import { programFileRefusal, readProgramFile } from './program.ts'
import { systemNow } from '../../../utils/clock.ts'

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

// Text jq writes as it is, a leading byte order mark included.
const DEC = new TextDecoder('utf-8', { ignoreBOM: true })
const ENC = new TextEncoder()

// The bindings, whose name and value the bag keeps as typed, and those whose
// value is a file the option loop asks for.
const BINDINGS: ReadonlySet<string> = new Set(['arg', 'argjson', 'rawfile', 'slurpfile'])
const FILE_BINDINGS: ReadonlySet<string> = new Set(['rawfile', 'slurpfile'])

// jq's exit status when it refuses the program itself, and when the program
// file holds a NUL byte.
const ERROR_COMPILE = 3
const ERROR_SYSTEM = 2

/**
 * The words one binding option holds, in the order typed: each name, then
 * the value it binds, or for a file binding the file. Mirrors Python's
 * _bound_words.
 */
function* boundWords(fl: FlagView, dest: string): Generator<string | PathSpec, void> {
  const raw = fl.raw(dest)
  const words: readonly (string | PathSpec)[] = Array.isArray(raw) ? raw : []
  for (const [at, word] of words.entries()) {
    yield at % 2 === 1 && FILE_BINDINGS.has(dest) ? fileOf(word) : word
  }
}

/**
 * The file a flag names: the PathSpec of the word typed, or one built from the
 * resolved path the flag arrived as. Mirrors Python's _file_of.
 */
function fileOf(word: FlagValue | undefined): PathSpec {
  if (word instanceof PathSpec) return word
  if (typeof word === 'string') return PathSpec.fromStrPath(word)
  throw new Error(`jq: a flag names no file: ${JSON.stringify(word)}`)
}

/**
 * jq's words in the order typed, as mirage-rs's option loop reads them, and
 * the file at each place on them that names one. The bag's tape keeps where
 * each word was typed, and the bag what it was: a binding's name and value,
 * and the file -f names, which the tape holds resolved. A file is named as
 * the word typed. Operands the bag has no tape for (a plain record) come
 * after every option.
 * Mirrors Python's option_tape.
 */
export function optionTape(
  fl: FlagView,
  texts: readonly string[],
): [[string, string][], Map<number, PathSpec>] {
  const bound = new Map([...BINDINGS].map((dest) => [dest, boundWords(fl, dest)]))
  const tape: [string, string][] = []
  const files = new Map<number, PathSpec>()
  for (const [dest, value] of fl.occurrences(...specFlagNames(specOf('jq')), OPERAND, REFUSED)) {
    const step = bound.get(dest)?.next()
    let word: FlagValue = value
    if (step !== undefined) word = step.done === true ? '' : step.value
    else if (dest === 'from_file') word = fileOf(fl.raw(dest))
    if (word instanceof PathSpec) {
      files.set(tape.length, word)
      tape.push([dest, flagFileName(word)])
    } else if (typeof word === 'string') {
      tape.push([dest, word])
    } else if (word === true) {
      tape.push([dest, ''])
    } else if (word !== false) {
      throw new Error(`jq: ${dest} holds no word: ${JSON.stringify(word)}`)
    }
  }
  if (!tape.some(([dest]) => dest === OPERAND)) {
    for (const word of texts) tape.push([OPERAND, word])
  }
  return [tape, files]
}

/**
 * Serves the files the option loop asks for: each --rawfile and --slurpfile
 * it reaches, read the way jq reads its inputs. `files` holds the file at
 * each place on the tape (optionTape). Mirrors Python's FlagFiles.
 */
class FlagFiles {
  readonly errors = new ByteSpool()

  constructor(
    private readonly files: ReadonlyMap<number, PathSpec>,
    private readonly read: (path: PathSpec) => Promise<Uint8Array>,
  ) {}

  /** Read one file, or say why it could not be read. */
  async serve(request: Readonly<Record<string, JsonValue>>): Promise<Served> {
    const file = typeof request.at === 'number' ? this.files.get(request.at) : undefined
    if (request.op !== 'read' || file === undefined)
      throw new Error(`jq: unknown option loop request ${JSON.stringify(request)}`)
    try {
      return { reply: { kind: 'data' }, data: await this.read(file) }
    } catch (error) {
      if (!isFsError(error)) throw error
      return {
        reply: { kind: 'error', message: fsStrerror(error) ?? '', directory: isEisdir(error) },
      }
    }
  }
}

/**
 * What jq's option loop decided for a run: the run config the options
 * decide, and the program, as the operand typed or the file -f names.
 * Mirrors Python's OptionPlan.
 */
export interface OptionPlan {
  readonly config: Readonly<Record<string, JsonValue>>
  readonly program: string | PathSpec
}

/**
 * jq's option loop in mirage-rs: the run it decides, what --help or
 * --version prints where the loop reaches one, or the first word it refuses
 * as the command's result, in jq's words. `tape` and `files` are
 * optionTape's, and `read` the byte reader for a --rawfile or --slurpfile.
 * Throws for a reply that lacks what the loop always answers. Mirrors
 * Python's read_options.
 */
export async function readOptions(
  tape: readonly (readonly [string, string])[],
  files: ReadonlyMap<number, PathSpec>,
  read: (path: PathSpec) => Promise<Uint8Array>,
): Promise<OptionPlan | Uint8Array | IOResult> {
  let stream: OpenStream
  try {
    stream = await openStream('jq_options', {
      options: tape.map(([name, text]) => [name, byteView(text)]),
    })
  } catch (error) {
    if (error instanceof StreamRefusal) return refused(error)
    throw error
  }
  const host = new FlagFiles(files, read)
  let reply: Uint8Array
  try {
    reply = await materialize(serveRequests(stream, host))
  } catch (error) {
    if (error instanceof StreamRefusal) return refused(error)
    throw error
  } finally {
    await host.errors.close()
    await closeStream(stream)
  }
  const plan = JSON.parse(DEC.decode(reply)) as Record<string, JsonValue>
  if (plan.answer === 'help') return ENC.encode(helpPage('jq', specOf('jq')))
  if (plan.answer === 'version') return ENC.encode(versionLine('jq'))
  const { config, program_file: at } = plan
  const answered = new Error(`jq: the option loop answered ${JSON.stringify(plan)}`)
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw answered
  if (at === null && typeof config.program === 'string') return { config, program: config.program }
  const file = typeof at === 'number' ? files.get(at) : undefined
  if (file === undefined) throw answered
  return { config, program: file }
}

/**
 * A flag's file as jq's reports name it: the word typed, `-` included, since
 * jq opens that one as a file too.
 */
export function flagFileName(path: PathSpec): string {
  return path.rawPath === '' ? path.virtual : path.rawPath
}

/** An input as jq's reports name it: the operand as typed, and `<stdin>` for `-`. */
export function inputName(path: PathSpec): string {
  if (path.rawPath === '-') return STDIN_NAME
  return path.rawPath === '' ? path.virtual : path.rawPath
}

// What the stream ends with once what jq holds outgrows the workspace's
// room (mirage-rs's jq EXHAUSTED). Mirrors Python's EXHAUSTED.
const EXHAUSTED = new MemoryExhausted().message

/**
 * The inputs jq's main loop reads, each opened when the loop first asks for
 * its bytes, as jq opens its files one after another, and the clock `now`
 * reads. `sources` are the inputs, in order, not yet opened; each goes over
 * in bounded pieces, so the loop holds no more of it than it is reading.
 * Mirrors Python's JqInputs.
 */
export class JqInputs {
  readonly errors = new ByteSpool()
  private readonly iterators: (AsyncIterator<Uint8Array> | null)[]
  private readonly sources: readonly AsyncIterable<Uint8Array>[]

  constructor(sources: readonly AsyncIterable<Uint8Array>[], signal?: AbortSignal) {
    this.sources = sources.map((source) => chunks(source, signal))
    this.iterators = sources.map(() => null)
  }

  /**
   * Answer the stream: the clock, or the next bytes of an input, its end, or
   * why it could not be opened or read, in strerror's words.
   */
  async serve(request: Readonly<Record<string, JsonValue>>): Promise<Served> {
    if (request.op === 'now') return { reply: { kind: 'now', now: systemNow() } }
    const index = request.input
    const source = typeof index === 'number' ? this.sources[index] : undefined
    if (request.op !== 'read' || typeof index !== 'number' || source === undefined)
      throw new Error(`jq: unknown host request ${JSON.stringify(request)}`)
    const iterator = (this.iterators[index] ??= source[Symbol.asyncIterator]())
    let next: IteratorResult<Uint8Array>
    try {
      next = await iterator.next()
    } catch (error) {
      if (!isFsError(error)) throw error
      const code = (error as { code?: string }).code
      return {
        reply: {
          kind: 'error',
          message: fsStrerror(error) ?? '',
          read: code !== undefined && READ_FAILURES.has(code),
        },
      }
    }
    if (next.done === true) return { reply: { kind: 'end' } }
    return { reply: { kind: 'data' }, data: next.value }
  }

  /** Close every input, the one the loop stopped in among them. */
  async close(): Promise<void> {
    for (const iterator of this.iterators) if (iterator !== null) await closeQuietly(iterator)
  }
}

/**
 * What mirage-rs's jq takes for one invocation: the program, what the option
 * loop decided (readOptions), `env` (JSON text) as `$ENV` and `env`, `zone`
 * (localZone) as the `TZ` local time reads, `origin` as the directory
 * `get_prog_origin` answers, and the inputs' names as jq reports them.
 * Mirrors Python's run_config.
 */
export function runConfig(
  expr: string,
  options: Readonly<Record<string, JsonValue>>,
  env: string,
  zone: string,
  origin: string | null,
  inputs: readonly string[],
): Record<string, JsonValue> {
  const limit = memoryRoom()
  return {
    ...options,
    program: expr,
    env,
    zone,
    prog_origin: origin,
    ...(limit === null ? {} : { memory: limit }),
    inputs: [...inputs],
  }
}

/**
 * jq's main loop in mirage-rs over the inputs, a bounded slice of work at a
 * time: what the runs print, as they print it, with jq's exit status and
 * stderr settled on `io` once the stream is drained. Throws MemoryExhausted,
 * after what was printed before it, once what jq holds outgrew the
 * workspace's room. Mirrors Python's run_outputs.
 */
export async function* runOutputs(
  config: Readonly<Record<string, JsonValue>>,
  inputs: JqInputs,
  io: IOResult,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void, undefined> {
  const stream = await openStream('jq', config)
  try {
    yield* serveRequests(stream, inputs, signal)
  } catch (error) {
    if (!(error instanceof StreamRefusal) || error.message !== EXHAUSTED) throw error
    if (error.output.byteLength > 0) yield error.output
    throw new MemoryExhausted()
  } finally {
    await closeRun(stream, inputs, io)
  }
}

/**
 * Settle a run's exit status and stderr on `io`, then close its inputs and
 * its stream, whatever settling threw: a spool that lost a write cannot hand
 * its contents on, and still frees what it holds. Mirrors Python's
 * _close_run.
 */
async function closeRun(stream: OpenStream, inputs: JqInputs, io: IOResult): Promise<void> {
  try {
    io.exitCode = stream.status()
    await inputs.errors.append(stream.takeStderr())
    io.stderr = await inputs.errors.output()
  } catch (error) {
    await inputs.errors.close()
    throw error
  } finally {
    await inputs.close()
    await closeStream(stream)
  }
}

export async function jqGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: Stream,
): Promise<CommandFnResult> {
  const readInput = stdinStream(stream, ctx.stdin)
  const fl = new FlagView(ctx.flags, specOf('jq'))
  // -f, --rawfile and --slurpfile route nothing (the executor's FILE_KEYS and
  // DISPATCH_FLAG_KEYS), so a file may sit on another mount than the operands: it
  // is read through the dispatcher. jq opens it by name, so /dev/stdin is the
  // invocation's own stdin and `-` is a file named `-`.
  const readFlagFile = (path: PathSpec): Promise<Uint8Array> => {
    if (isStdin(path, false)) return materialize(readInput(path))
    if (ctx.vfs === undefined) return materialize(stream(path))
    return readProgramFile('jq', path, ctx.vfs.dispatch)
  }
  // jq reads its options before its program, so a refused option is reported
  // before an -f file is read.
  const plan = await readOptions(...optionTape(fl, texts), readFlagFile)
  if (plan instanceof IOResult) return [null, plan]
  if (plan instanceof Uint8Array) return [plan, new IOResult()]
  const { config: options, program } = plan
  const programFile = program instanceof PathSpec ? program : null
  let expression = typeof program === 'string' ? program : ''
  if (programFile !== null) {
    let data: Uint8Array
    try {
      data = await readFlagFile(programFile)
    } catch (error) {
      if (!isFsError(error)) throw error
      const [line, code] = programFileRefusal('jq', programFile, error)
      return [null, new IOResult({ exitCode: code, stderr: ENC.encode(line) })]
    }
    if (data.includes(0)) {
      return [
        null,
        new IOResult({
          exitCode: ERROR_SYSTEM,
          stderr: ENC.encode('jq: program file contains NUL bytes\n'),
        }),
      ]
    }
    expression = DEC.decode(data)
  }
  const origin = programFile === null ? ctx.cwd.virtual : parent(programFile.virtual)
  // `$ENV` and `env` read the session's exported environment in place of
  // jq's process environment, and local time its `TZ`.
  const env = JSON.stringify(ctx.env ?? {})
  const zone = localZone(ctx.env)
  const operands = [...paths]
  const names = operands.map(inputName)
  if (operands.length === 0 && ctx.stdin !== null) {
    operands.push(PathSpec.fromStrPath('/dev/stdin'))
    names.push(STDIN_NAME)
  }
  try {
    // jq compiles its program before it opens a single input, so a
    // refusal is all it prints. mirage-rs words jq's refusals itself,
    // reading the program as typed, so its lines and columns are jq's. The
    // run compiles it again when it starts, so nothing is held open for a
    // stream no one reads.
    const checked = await openStream('jq', runConfig(expression, options, env, zone, origin, names))
    await closeStream(checked)
  } catch (error) {
    if (!(error instanceof StreamRefusal) || !COMPILE_REPORT.test(error.message)) throw error
    return [
      null,
      new IOResult({ exitCode: ERROR_COMPILE, stderr: ENC.encode(`${error.message}\n`) }),
    ]
  }
  const config = runConfig(expression.trim(), options, env, zone, origin, names)
  // Each input opens when the loop first reads it, as jq opens its files one
  // after another, so -n never opens one its program does not read.
  const inputs = new JqInputs(
    operands.map((path) => readInput(path)),
    ctx.signal,
  )
  const io = new IOResult()
  return [runOutputs(config, inputs, io, ctx.signal), io]
}
