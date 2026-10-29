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

// The option loop, main loop and exit statuses follow jq 1.8.2's
// src/main.c (MIT; see licenses/third_party/jq.txt).

import { specOf } from '../../spec/builtins.ts'
import { OPERAND, REFUSED } from '../../spec/constants.ts'
import { FlagView } from '../../spec/flag_view.ts'
import {
  DEFAULT_INDENT,
  NO_VALUE,
  STDIN_NAME,
  decodeUtf8,
  jqOptions,
  loadFailure,
  localZone,
  readTexts,
  stringText,
  valueText,
  type JqOptions,
} from '../../../core/jq/index.ts'
import { COMPILE_REPORT } from '../../../core/jq/eval.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { closeStream, openStream, serveRequests, type Served } from '../../../rs/stream.ts'
import { MemoryExhausted } from '../../../io/errors.ts'
import { memoryRoom } from '../../../io/memory.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { closeQuietly } from '../../../io/stream.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec, type JsonValue } from '../../../types.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { parent } from '../../../utils/path.ts'
import { type CommandFnResult, type Context } from '../../config.ts'
import { helpPage, versionLine } from '../../spec/standard.ts'
import { UsageError } from '../../errors.ts'
import { isStdin, stdinStream } from '../utils/stream.ts'
import { programFileRefusal, readProgramFile } from './program.ts'

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

// Text jq writes as it is, a leading byte order mark included.
const DEC = new TextDecoder('utf-8', { ignoreBOM: true })
const ENC = new TextEncoder()
const INDENT_MIN = -1
const INDENT_MAX = 7
// A width in jq's range has at most one significant digit; the sign and
// leading zeroes keep strtol's decimal spelling without a large conversion.
const INDENT_WORD = /^([+-]?)0*([0-7])$/

// The options whose order decides what they do: the layout options, which
// reset one another, the bindings, where the first of a name wins, and the
// modes, which file the operands typed after them.
const LAYOUT = ['compact_output', 'tab', 'indent'] as const
const BINDINGS = ['arg', 'argjson', 'rawfile', 'slurpfile'] as const
const MODES = ['args', 'jsonargs'] as const
// The options jq answers where its loop reaches them, and then exits.
const STANDARD = ['help', 'version'] as const
type Binding = (typeof BINDINGS)[number]
type Mode = (typeof MODES)[number]

// jq's exit status when it refuses the program itself, and when it could not
// read one of its inputs, whatever the runs answered.
const ERROR_COMPILE = 3
const ERROR_SYSTEM = 2

const USAGE_HINT =
  'Use jq --help for help with command-line options,\n' +
  'or see the jq manpage, or online docs at https://jqlang.org'

// What jq says for an option the line ends before the values of (main.c).
const TAKES: Readonly<Record<string, string>> = {
  '--arg': '--arg takes two parameters (e.g. --arg varname value)',
  '--argjson': '--argjson takes two parameters (e.g. --argjson varname text)',
  '--rawfile': '--rawfile takes two parameters (e.g. --rawfile varname filename)',
  '--slurpfile': '--slurpfile takes two parameters (e.g. --slurpfile varname filename)',
  '--indent': '--indent takes one parameter',
}

// jq's -f is a switch that makes the program operand a file, so an -f the
// line ends at leaves jq no program, and it prints usage(2, 1), its short
// usage, to stderr.
const SHORT_USAGE =
  'jq - commandline JSON processor [version 1.8.2]\n\n' +
  'Usage:\tjq [options] <jq filter> [file...]\n' +
  '\tjq [options] --args <jq filter> [strings...]\n' +
  '\tjq [options] --jsonargs <jq filter> [JSON_TEXTS...]\n\n' +
  'jq is a tool for processing JSON inputs, applying the given filter to\n' +
  "its JSON text inputs and producing the filter's results as JSON on\n" +
  'standard output.\n\n' +
  "The simplest filter is ., which copies jq's input to its output\n" +
  'unmodified except for formatting. For more advanced filters see\n' +
  'the jq(1) manpage ("man jq") and/or https://jqlang.org/.\n\n' +
  'Example:\n\n' +
  '\t$ echo \'{"foo": 0}\' | jq .\n' +
  '\t{\n' +
  '\t  "foo": 0\n' +
  '\t}\n\n' +
  'For listing the command options, use jq --help.'

/**
 * jq's refusal of one option its loop cannot take. `word` is the option as
 * the parser left it on the tape: a word jq does not know, or an option the
 * line ends before the values of.
 */
export function optionRefusal(word: string): UsageError {
  if (word === '-f' || word === '--from-file') return new UsageError(SHORT_USAGE, 2)
  const line = TAKES[word] ?? `Unknown option ${word}`
  return new UsageError(`jq: ${line}\n${USAGE_HINT}`, 2)
}

function pairArgs(values: readonly string[]): [string, string][] {
  const pairs: [string, string][] = []
  for (let i = 0; i + 1 < values.length; i += 2) {
    pairs.push([values[i] ?? '', values[i + 1] ?? ''])
  }
  return pairs
}

/**
 * The JSON text one operand gives `$ARGS.positional`: the string it spells
 * after --args, and after --jsonargs the one JSON value it spells, as jq's own
 * parser reads it. `mode` is the last of the two typed before it. A --jsonargs
 * operand that is not one JSON value is refused in jq's words.
 */
export async function positionalValue(mode: Mode, word: string): Promise<string> {
  if (mode === 'args') return stringText(word)
  const text = await valueText(ENC.encode(word))
  if (text === NO_VALUE) {
    throw new UsageError(`jq: invalid JSON text passed to --jsonargs\n${USAGE_HINT}`, 2)
  }
  return text
}

/**
 * A path pair option's [name, file] pairs, each file the PathSpec of the
 * word that spelled it, or one built from its resolved path.
 */
function pathPairs(fl: FlagView, option: string): [string, PathSpec][] {
  const raw = fl.raw(option)
  if (!Array.isArray(raw)) return []
  const items: readonly (string | PathSpec)[] = raw
  const pairs: [string, PathSpec][] = []
  for (let i = 0; i + 1 < items.length; i += 2) {
    const name = items[i]
    const file = items[i + 1]
    if (typeof name !== 'string' || file === undefined) continue
    pairs.push([name, file instanceof PathSpec ? file : PathSpec.fromStrPath(file)])
  }
  return pairs
}

/**
 * The JSON text one binding gives its name: --arg a string, --argjson one
 * JSON value, --rawfile a file's text, and --slurpfile the array of
 * documents in a file, which is the same difference -R draws on the input
 * stream. `value` is the word --arg or --argjson binds, or the file
 * --rawfile or --slurpfile reads. Both files are read the way jq reads its
 * inputs. An --argjson value that is not one JSON value as jq's own parser
 * reads it, a file that cannot be read, and a --slurpfile holding bad JSON
 * are refused in jq's words.
 */
async function binding(
  dest: Binding,
  name: string,
  value: string | PathSpec,
  read: (path: PathSpec) => Promise<Uint8Array>,
): Promise<string> {
  if (typeof value === 'string') {
    if (dest === 'arg') return stringText(value)
    const text = await valueText(ENC.encode(value))
    if (text === NO_VALUE) {
      throw new UsageError(`jq: invalid JSON text passed to --argjson\n${USAGE_HINT}`, 2)
    }
    return text
  }
  const data = await loadFile(read, dest, name, value)
  if (dest === 'rawfile') return stringText(await decodeUtf8(data))
  const shown = flagFileName(value)
  const [texts, failure] = await readTexts(data)
  if (failure !== null) {
    throw new UsageError(
      `jq: Bad JSON in --slurpfile ${name} ${shown}: ${failure.message}`,
      ERROR_SYSTEM,
    )
  }
  return `[${texts.join(',')}]`
}

/**
 * One --rawfile or --slurpfile file's bytes. One that cannot be read is
 * refused in the words jq has for it, which call it bad JSON too.
 */
async function loadFile(
  read: (path: PathSpec) => Promise<Uint8Array>,
  option: string,
  name: string,
  path: PathSpec,
): Promise<Uint8Array> {
  try {
    return await read(path)
  } catch (error) {
    if (!isFsError(error)) throw error
    const shown = flagFileName(path)
    throw new UsageError(
      `jq: Bad JSON in --${option} ${name} ${shown}: ${loadFailure(shown, error)}`,
      ERROR_SYSTEM,
    )
  }
}

/**
 * The width an --indent word names, read as jq 1.8.2's strtol reads it: a
 * sign and decimal digits and nothing else, no blank before and no text
 * after, from -1 to 7. Only the significant digit is converted, so the
 * width never depends on the host's handling of arbitrary-length numbers.
 * Any other word is refused in jq's words.
 */
export function indentWidth(word: string): number {
  const match = INDENT_WORD.exec(word)
  const width =
    match !== null && match[0] === word ? Number(match[2]) * (match[1] === '-' ? -1 : 1) : NaN
  if (!(width >= INDENT_MIN && width <= INDENT_MAX)) {
    throw new UsageError(
      `jq: --indent takes a number between ${String(INDENT_MIN)} and ` +
        `${String(INDENT_MAX)}\n${USAGE_HINT}`,
      2,
    )
  }
  return width === 0 ? 0 : width
}

/**
 * Read the jq flags whose order does not matter into a frozen struct: the
 * layout stays jq's default and nothing is bound, which readOptions reads in
 * the order typed.
 */
export function parseFlags(fl: FlagView): JqOptions {
  const joinOutput = fl.asBool('join_output')
  const nulOutput = fl.asBool('raw_output0')
  return jqOptions({
    nullInput: fl.asBool('null_input'),
    rawInput: fl.asBool('raw_input'),
    slurp: fl.asBool('slurp'),
    stream: fl.asBool('stream'),
    seq: fl.asBool('seq'),
    // -j and --raw-output0 are -r plus a different separator.
    rawOutput: fl.asBool('raw_output') || joinOutput || nulOutput,
    joinOutput,
    nulOutput,
    asciiOutput: fl.asBool('ascii_output'),
    sortKeys: fl.asBool('sort_keys'),
    exitStatus: fl.asBool('exit_status'),
  })
}

/**
 * Read the jq flags, and the operands --args and --jsonargs file, into a
 * frozen struct the way jq's option loop (main.c) reads them: one word at a
 * time, in the order typed.
 *
 * The layout options reset one another, so the last of `-c`, `--tab` and
 * `--indent` decides (`--indent -1` is `--tab`). A binding takes its name
 * only while the name is free: the first `--arg`, `--argjson`, `--rawfile`
 * or `--slurpfile` of a name wins, as `$name` and in `$ARGS.named`, which
 * lists the names in the order they were bound. A later binding of the name
 * is never read, so its JSON is not parsed and its file is not opened. The
 * program is the first operand, whatever the mode. Every operand after it is
 * filed by the last of `--args` and `--jsonargs` typed before it: a string,
 * or one JSON value parsed right then. One typed before either is an input
 * file, which the parser left a path. An option jq refuses stops the loop
 * where it stands, so the refusal reported is the first one typed, a
 * `--jsonargs` operand's included. Operands the bag has no tape for (a plain
 * record) come after every option. `texts` are the text operands, program
 * first unless -f gave it (`hasProgramFile`), and `read` is the byte reader
 * for a --rawfile or --slurpfile.
 */
export async function readOptions(
  fl: FlagView,
  texts: readonly string[],
  hasProgramFile: boolean,
  read: (path: PathSpec) => Promise<Uint8Array>,
): Promise<JqOptions | Uint8Array> {
  let compact = false
  let tab = false
  let indent = DEFAULT_INDENT
  const named = new Map<string, string>()
  const positional: string[] = []
  let mode: Mode | null = null
  let program = !hasProgramFile
  const words = (program ? texts.slice(1) : texts).values()
  const pairs = {
    arg: pairArgs(fl.asList('arg')).values(),
    argjson: pairArgs(fl.asList('argjson')).values(),
    rawfile: pathPairs(fl, 'rawfile').values(),
    slurpfile: pathPairs(fl, 'slurpfile').values(),
  }
  const tape = fl
    .occurrences(...LAYOUT, ...BINDINGS, ...MODES, ...STANDARD, OPERAND, REFUSED)
    .values()
  for (const [dest, value] of tape) {
    if (dest === REFUSED) throw optionRefusal(String(value))
    if (dest === 'help') return ENC.encode(helpPage('jq', specOf('jq')))
    if (dest === 'version') return ENC.encode(versionLine('jq'))
    if (dest === OPERAND) {
      if (program) {
        program = false
      } else if (mode !== null) {
        const word = words.next()
        if (word.done !== true) positional.push(await positionalValue(mode, word.value))
      }
    } else if (dest === 'args' || dest === 'jsonargs') {
      mode = dest
    } else if (dest === 'compact_output') {
      compact = true
      tab = false
    } else if (dest === 'tab') {
      compact = false
      tab = true
    } else if (dest === 'indent') {
      const width = indentWidth(String(value))
      compact = false
      tab = width === INDENT_MIN
      indent = tab ? DEFAULT_INDENT : width
    } else {
      // A binding is two words on the tape, its name and what it binds, and
      // the bag keeps each pair as typed.
      tape.next()
      const kind = dest as Binding
      const pair = pairs[kind].next()
      if (pair.done === true) continue
      const [name, bound] = pair.value
      if (!named.has(name)) named.set(name, await binding(kind, name, bound, read))
    }
  }
  if (mode !== null) for (const word of words) positional.push(await positionalValue(mode, word))
  return jqOptions({
    ...parseFlags(fl),
    compact,
    tab,
    indent,
    namedArgs: named,
    positionalArgs: positional,
  })
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
 * reads. `sources` are the inputs, in order, not yet opened. Mirrors
 * Python's JqInputs.
 */
export class JqInputs {
  readonly errors = new ByteSpool()
  private readonly iterators: (AsyncIterator<Uint8Array> | null)[]

  constructor(private readonly sources: readonly AsyncIterable<Uint8Array>[]) {
    this.iterators = sources.map(() => null)
  }

  /**
   * Answer the stream: the clock, or the next bytes of an input, its end, or
   * why it could not be opened or read, in strerror's words.
   */
  async serve(request: Readonly<Record<string, JsonValue>>): Promise<Served> {
    if (request.op === 'now') return { reply: { kind: 'now', now: Date.now() / 1000 } }
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
 * What mirage-rs's jq takes for one invocation: the program, the options,
 * `env` (JSON text) as `$ENV` and `env`, `zone` (localZone) as the `TZ` local
 * time reads, `origin` as the directory `get_prog_origin` answers, and the
 * inputs' names as jq reports them. Mirrors Python's run_config.
 */
export function runConfig(
  expr: string,
  opts: JqOptions,
  env: string,
  zone: string,
  origin: string | null,
  inputs: readonly string[],
): Record<string, JsonValue> {
  const limit = memoryRoom()
  return {
    program: expr,
    named: [...opts.namedArgs].map(([name, text]) => [name, text]),
    positional: [...opts.positionalArgs],
    env,
    zone,
    prog_origin: origin,
    ...(limit === null ? {} : { memory: limit }),
    inputs: [...inputs],
    null_input: opts.nullInput,
    raw_input: opts.rawInput,
    slurp: opts.slurp,
    stream: opts.stream,
    seq: opts.seq,
    exit_status: opts.exitStatus,
    raw_output: opts.rawOutput,
    join_output: opts.joinOutput,
    nul_output: opts.nulOutput,
    ascii_output: opts.asciiOutput,
    sort_keys: opts.sortKeys,
    compact: opts.compact,
    tab: opts.tab,
    indent: opts.indent,
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
    io.exitCode = stream.status()
    await inputs.errors.append(stream.takeStderr())
    io.stderr = await inputs.errors.output()
    await inputs.close()
    await closeStream(stream)
  }
}

/**
 * The file -f names, as the word typed when the bag kept it, else built from
 * the resolved virtual path the flag arrived as.
 */
function programFileOf(fl: FlagView): PathSpec | null {
  const raw = fl.raw('from_file')
  if (raw instanceof PathSpec) return raw
  return typeof raw === 'string' ? PathSpec.fromStrPath(raw) : null
}

export async function jqGeneric(
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
  stream: Stream,
): Promise<CommandFnResult> {
  const readInput = stdinStream(stream, ctx.stdin)
  const fl = new FlagView(ctx.flags, specOf('jq'))
  const programFile = programFileOf(fl)
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
  const jq = await readOptions(fl, texts, programFile !== null, readFlagFile)
  if (jq instanceof Uint8Array) return [jq, new IOResult()]
  // jq defaults the filter to "." when no expression is given.
  let expression = texts[0] ?? '.'
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
    const checked = await openStream('jq', runConfig(expression, jq, env, zone, origin, names))
    await closeStream(checked)
  } catch (error) {
    if (!(error instanceof StreamRefusal) || !COMPILE_REPORT.test(error.message)) throw error
    return [
      null,
      new IOResult({ exitCode: ERROR_COMPILE, stderr: ENC.encode(`${error.message}\n`) }),
    ]
  }
  const config = runConfig(expression.trim(), jq, env, zone, origin, names)
  // Each input opens when the loop first reads it, as jq opens its files one
  // after another, so -n never opens one its program does not read.
  const inputs = new JqInputs(operands.map((path) => readInput(path)))
  const io = new IOResult()
  return [runOutputs(config, inputs, io, ctx.signal), io]
}
