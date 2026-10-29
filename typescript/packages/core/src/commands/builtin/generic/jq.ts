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

import { YieldBudget } from '../../../io/yield_budget.ts'
import { specOf } from '../../spec/builtins.ts'
import { OPERAND, REFUSED } from '../../spec/constants.ts'
import { FlagView } from '../../spec/flag_view.ts'
import {
  DEFAULT_INDENT,
  InputReader,
  JqCompileError,
  JqParseError,
  NO_VALUE,
  STDIN_NAME,
  argsText,
  decodeUtf8,
  errorReport,
  formatOne,
  haltReport,
  jqOptions,
  loadFailure,
  printConfig,
  readTexts,
  referencesArgs,
  streamReads,
  stringText,
  valueText,
  type InputSource,
  type JqError,
  type JqHalt,
  type JqOptions,
} from '../../../core/jq/index.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { closeStream, openStream, type OpenStream } from '../../../rs/stream.ts'
import { MemoryExhausted } from '../../../io/errors.ts'
import { memoryRoom } from '../../../io/memory.ts'
import { yieldBytes } from '../../../io/stream.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec, type JsonValue } from '../../../types.ts'
import { isFsError } from '../../../errors/fs.ts'
import { parent } from '../../../utils/path.ts'
import { concat } from '../../../utils/bytes.ts'
import { TZ_VAR } from '../../../utils/timezone.ts'
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

// What jq's process() answers for one run, which its exit status is made
// of (main.c): the last output was not false or null, it was, there was
// none, and an error no `try` caught ended the run.
const OK = 0
const OK_NULL_KIND = -1
const OK_NO_OUTPUT = -4
const ERROR_UNKNOWN = 5

// The frames a jq_eval drain writes: an output's compact dump, the error
// that ended the run, a halt, a `debug` line, what `stderr` writes and an
// output printed.
const FRAME_OUTPUT = 1
const FRAME_ERROR = 2
const FRAME_HALT = 3
const FRAME_DEBUG = 4
const FRAME_STDERR = 5
const FRAME_PRINT = 6

// jq's exit status when it refuses the program itself, and when it could not
// read one of its inputs, whatever the runs answered.
const ERROR_COMPILE = 3
const ERROR_SYSTEM = 2

// The last line of jq's report of a program it refuses, which jq_eval's
// refusal to compile such a program ends in; any other refusal names what
// jq_eval cannot run yet.
const COMPILE_REPORT = /(?:^|\n)jq: [0-9]+ compile errors?$/

// The error jq_eval ends a run with once it holds more than its memory, `{}`
// the bytes. Mirrors Python's MEMORY_REPORT.
const MEMORY_REPORT = 'jq memory limit of {} bytes exceeded'

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

/**
 * The time zone jq's local time reads, as a `TZ` value: the command
 * environment's, else the process's, else the host's tz database zone.
 */
export function localZone(env: Record<string, string> | undefined): string {
  const host = globalThis as {
    process?: { env?: Record<string, string | undefined> }
  }
  return (
    env?.[TZ_VAR] ?? host.process?.env?.[TZ_VAR] ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  )
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
  const [texts, failure] = await readTexts({ name: shown, chunks: yieldBytes(data) })
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

/** What jq's process() answers for one run, from how it ended. */
export function runStatus(ending: Ending): number {
  if (ending.stop?.kind === 'halt') {
    return ending.stop.code === null ? OK : Math.trunc(ending.stop.code)
  }
  if (ending.stop?.kind === 'error') return ERROR_UNKNOWN
  if (!ending.printed) return OK_NO_OUTPUT
  return ending.falsy ? OK_NULL_KIND : OK
}

/**
 * Read one jq_eval drain into a run: every output, print, debug or stderr
 * frame onto `frames` as its tag and payload, in the order the run wrote
 * them, and the stop an error or halt frame names, or null. A frame is a
 * tag, a little-endian u32 length and its payload: an output's dump, an
 * error's flag byte (bit 0 for a string, bit 1 when the program raised it
 * with `error` itself) then its text, a halt's JSON, a `debug` line's dump,
 * the text `stderr` writes, or an output printed (a byte set when it was
 * null or false, then its bytes).
 */
export function readFrames(
  bytes: Uint8Array,
  frames: [number, Uint8Array][],
): JqError | JqHalt | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let stop: JqError | JqHalt | null = null
  let at = 0
  while (at < bytes.byteLength) {
    if (at + 5 > bytes.byteLength) throw new Error('jq_eval: truncated frame header')
    const tag = view.getUint8(at)
    const end = at + 5 + view.getUint32(at + 1, true)
    if (end > bytes.byteLength) throw new Error('jq_eval: truncated frame')
    const payload = bytes.subarray(at + 5, end)
    at = end
    if (
      tag === FRAME_OUTPUT ||
      tag === FRAME_PRINT ||
      tag === FRAME_DEBUG ||
      tag === FRAME_STDERR
    ) {
      frames.push([tag, payload])
    } else if (tag === FRAME_ERROR) {
      const flags = payload[0] ?? 0
      stop = {
        kind: 'error',
        text: DEC.decode(payload.subarray(1)),
        string: (flags & 1) === 1,
        own: (flags & 2) === 2,
      }
    } else if (tag === FRAME_HALT) {
      const halt = JSON.parse(DEC.decode(payload)) as Omit<JqHalt, 'kind'>
      stop = { kind: 'halt', message: halt.message, string: halt.string, code: halt.code }
    } else {
      throw new Error(`jq_eval: unknown frame ${String(tag)}`)
    }
  }
  return stop
}

/**
 * Where jq's input reader stands, as jq_eval takes it: the input it reads
 * and the lines read of it.
 */
export function readerPosition(reader: InputReader): { filename: string | null; line: number } {
  return { filename: reader.filename(), line: reader.lineNumber() }
}

/**
 * jq's input callback (util.c) answering one `input`: the reader's next
 * document, the end of the stream, or its parse error, and where the reader
 * stands after it.
 */
export async function inputReply(
  reader: InputReader,
): Promise<[Record<string, string | number | null>, Uint8Array]> {
  const item = await reader.nextInput()
  const position = readerPosition(reader)
  if (item === NO_VALUE) return [{ kind: 'end', ...position }, new Uint8Array()]
  if (item instanceof JqParseError) {
    return [{ kind: 'error', ...position }, ENC.encode(item.message)]
  }
  return [{ kind: 'value', ...position }, ENC.encode(item)]
}

/**
 * How a run whose outputs went out as it made them ended: the error or halt
 * that stopped it, if one did, and for a printed run whether it printed an
 * output and whether the last was null or false.
 */
export interface Ending {
  stop: JqError | JqHalt | null
  printed?: boolean
  falsy?: boolean
}

/**
 * A program compiled once by mirage-rs's jq_eval and run on this thread, a
 * bounded number of VM steps per drain, so a program that never ends still
 * yields and the signal can stop it between two.
 */
export class Engine {
  private readonly budget: YieldBudget
  // jq's debug callback prints compactly, with -S and -a but none of the
  // layout or raw options (main.c's dumpopts less pretty).
  private readonly debugOpts: JqOptions

  // What the workspace's max_memory had left when the program compiled, the
  // bytes the run may hold; null for jq_eval's own.
  private constructor(
    private readonly stream: OpenStream,
    opts: JqOptions,
    private readonly memory: number | null,
    private readonly signal?: AbortSignal,
  ) {
    this.budget = new YieldBudget(signal)
    this.debugOpts = jqOptions({
      ...opts,
      compact: true,
      tab: false,
      rawOutput: false,
      joinOutput: false,
      nulOutput: false,
      seq: false,
    })
  }

  /**
   * Compile `expr`, as typed, with the options' named bindings, `args` as
   * `$ARGS`, `env` (JSON text) as `$ENV` and `env`, `zone` (localZone) as
   * the `TZ` local time reads and `origin` as the directory
   * `get_prog_origin` answers. `printing` has jq_eval print the outputs by
   * the options, for `print`, instead of dumping them, for `run`. Throws
   * JqCompileError, with jq's report, for a program jq itself refuses.
   */
  static async open(
    expr: string,
    opts: JqOptions,
    args: string | null,
    env: string,
    zone: string,
    origin: string | null,
    signal?: AbortSignal,
    printing = false,
  ): Promise<Engine> {
    let stream: OpenStream
    const limit = memoryRoom()
    try {
      stream = await openStream('jq_eval', {
        program: expr,
        named: Object.fromEntries(opts.namedArgs),
        args,
        env,
        zone,
        prog_origin: origin,
        ...(limit === null ? {} : { memory: limit }),
        ...(printing ? { print: printConfig(opts) } : {}),
      })
    } catch (error) {
      if (error instanceof StreamRefusal && COMPILE_REPORT.test(error.message)) {
        throw new JqCompileError(error.message)
      }
      throw error
    }
    return new Engine(stream, opts, limit, signal)
  }

  /**
   * Run the program on one document's JSON text, yielding each output's
   * compact dump as a drain decodes it, and leave on `ending` how the run
   * stopped (see `drains`).
   */
  async *run(
    doc: string,
    reader: InputReader,
    report: (line: string) => void,
    ending: Ending,
  ): AsyncGenerator<string, void, undefined> {
    for await (const outputs of this.drains(doc, reader, report, ending)) {
      for (const output of outputs) yield DEC.decode(output)
    }
  }

  /**
   * Run a program opened for printing on one document's JSON text, yielding
   * what each drain printed as one chunk, and leave on `ending` how the run
   * stopped and what it printed last (see `drains`).
   */
  async *print(
    doc: string,
    reader: InputReader,
    report: (line: string) => void,
    ending: Ending,
  ): AsyncGenerator<Uint8Array, void, undefined> {
    for await (const outputs of this.drains(doc, reader, report, ending)) {
      ending.printed = true
      ending.falsy = outputs[outputs.length - 1]?.[0] === 1
      yield concat(outputs.map((output) => output.subarray(1)))
    }
  }

  /**
   * Run the program on one document's JSON text, yielding each drain's
   * outputs, those between two `debug` or `stderr` lines together, so the
   * lines go to `report` in the order the run wrote them, and leave on
   * `ending` how the run stopped.
   *
   * Each `input` the program calls takes the reader's next document then and
   * there, as jq's input callback does, so the run consumes exactly what it
   * asks for and the main loop reads on after it. A run its caller stops
   * reading is cancelled, so the next can begin.
   */
  private async *drains(
    doc: string,
    reader: InputReader,
    report: (line: string) => void,
    ending: Ending,
  ): AsyncGenerator<Uint8Array[], void, undefined> {
    const stream = this.stream
    stream.begin(readerPosition(reader))
    const frames: [number, Uint8Array][] = []
    let stop: JqError | JqHalt | null
    // Whether the caller stopped reading while the run was still going.
    let abandoned = true
    try {
      stop = readFrames(stream.feed(ENC.encode(doc)), frames)
      stop = readFrames(stream.finish(), frames) ?? stop
      for (;;) {
        let outputs: Uint8Array[] = []
        for (const [tag, payload] of frames) {
          if (tag === FRAME_OUTPUT || tag === FRAME_PRINT) {
            outputs.push(payload)
            continue
          }
          if (outputs.length > 0) {
            yield outputs
            outputs = []
          }
          report(await this.message(tag, DEC.decode(payload)))
        }
        frames.length = 0
        if (outputs.length > 0) yield outputs
        let wire: Uint8Array
        if (stream.busy()) {
          const pending = this.budget.run()
          if (pending !== undefined) await pending
          wire = stream.drain()
        } else {
          const asked = stream.request()
          if (asked === null) break
          let reply: Record<string, JsonValue>
          let data: Uint8Array = new Uint8Array()
          if (asked[0].op === 'now') {
            reply = { kind: 'now', now: Date.now() / 1000 }
          } else if (asked[0].op === 'input') {
            ;[reply, data] = await inputReply(reader)
          } else {
            throw new Error(`jq_eval: unknown host request ${JSON.stringify(asked[0])}`)
          }
          wire = stream.respond(reply, data)
        }
        stop = readFrames(wire, frames) ?? stop
      }
      abandoned = false
    } catch (error) {
      abandoned = false
      throw error
    } finally {
      if (abandoned) await this.cancel()
    }
    if (
      this.memory !== null &&
      stop?.kind === 'error' &&
      stop.text === MEMORY_REPORT.replace('{}', String(this.memory))
    ) {
      throw new MemoryExhausted()
    }
    ending.stop = stop
  }

  // Stop the run in flight and retire it, so the next can begin.
  private async cancel(): Promise<void> {
    if (!this.stream.cancel()) return
    while (this.stream.busy()) {
      const pending = this.budget.run()
      if (pending !== undefined) await pending
      this.stream.drain()
    }
  }

  // `debug` prints its line through jq's dumper, `stderr` its text.
  private async message(tag: number, text: string): Promise<string> {
    if (tag === FRAME_STDERR) return text
    return DEC.decode(await formatOne(text, this.debugOpts, this.signal))
  }

  /** Close the program; a run cut short is retired a bounded slice at a time. */
  close(): Promise<void> {
    return closeStream(this.stream)
  }
}

/**
 * Exit status for the program run over the whole input, as jq's main loop
 * settles it from what each run answered (runStatus).
 *
 * Only the last run counts, even after one that failed, unless it printed
 * nothing, when -e looks back to the last value any run printed. Without
 * -e only a failure shows, and a halt's own code.
 */
export function exitCode(statuses: readonly number[], opts: JqOptions): number {
  let ret = OK_NO_OUTPUT
  let lastResult = -1
  for (const status of statuses) {
    ret = status
    if (status <= 0 && status !== OK_NO_OUTPUT) lastResult = status === OK_NULL_KIND ? 0 : 1
  }
  let code: number
  if (!opts.exitStatus) code = Math.max(ret, 0)
  else if (ret !== OK_NO_OUTPUT) code = Math.abs(ret)
  else code = lastResult === -1 ? 4 : lastResult === 0 ? 1 : 0
  return code % 256
}

/**
 * jq's report of a parse error its main loop meets: fatal, or under --seq a
 * line it prints before reading on.
 */
export function parseReport(failure: JqParseError, opts: JqOptions): string {
  const kind = opts.seq ? 'ignoring parse error' : 'parse error'
  return `jq: ${kind}: ${failure.message}\n`
}

/**
 * jq's main loop (main.c) over an invocation's input stream.
 *
 * Each document runs as soon as the reader parses it, and its outputs stream
 * out. A run's error is reported and the next document runs; a halt ends the
 * loop; a parse error is reported with status 5 and ends it, except under
 * --seq, which reports it and reads on. Under -n the program runs once, on
 * null. The exit status and stderr settle on `io` once the stream is
 * drained.
 *
 * A program runs in mirage-rs's jq_eval, compiled once per invocation and
 * stepped in bounded slices on this thread, so a run that never ends still
 * yields to the signal. Its `input` and `inputs` take each document from the
 * reader when they ask for it, as jq's input callback does, so the next run
 * starts after the documents the program consumed, and `debug` and `stderr`
 * lines go to stderr in the order they were written, before the run's own
 * report. `env` (JSON text) is what `$ENV` and `env` read, `zone`
 * (localZone) the `TZ` local time reads and `origin` the directory
 * `get_prog_origin` answers.
 *
 * An input that cannot be opened or read is reported when the reader reaches
 * it, and the reader goes on to the next. The loop checks for such a failure
 * before each document it reads, so it stops after the run of the document
 * the failing read went on to, and the exit status is 2 whatever the runs
 * answered. `sources` are the inputs, in order, not yet opened.
 */
export class MainLoop {
  // The compiled program, once the first run asks for it.
  private engine: Engine | null = null
  private readonly statuses: number[] = []
  private readonly reports: string[] = []
  private readonly reader: InputReader
  private halted = false

  constructor(
    sources: readonly InputSource[],
    private readonly expr: string,
    private readonly opts: JqOptions,
    private readonly args: string | null,
    private readonly env: string,
    private readonly zone: string,
    private readonly origin: string | null,
    private readonly io: IOResult,
    private readonly signal?: AbortSignal,
  ) {
    this.reader = new InputReader(sources, opts, (line) => this.reports.push(line), signal)
  }

  /** The invocation's stdout, each drain's outputs as its run prints them. */
  async *outputs(): AsyncIterable<Uint8Array> {
    try {
      if (this.opts.nullInput) {
        yield* this.run('null')
        return
      }
      while (this.reader.failures() === 0) {
        const item = await this.reader.nextInput()
        if (item === NO_VALUE) return
        if (item instanceof JqParseError) {
          this.fail(item)
          if (this.opts.seq) continue
          return
        }
        yield* this.run(item)
        if (this.halted) return
      }
    } finally {
      this.io.exitCode =
        this.reader.failures() > 0 ? ERROR_SYSTEM : exitCode(this.statuses, this.opts)
      if (this.reports.length > 0) this.io.stderr = ENC.encode(this.reports.join(''))
      await this.engine?.close()
      await this.reader.close()
    }
  }

  /**
   * Run the program on one document (null under -n), printing its outputs as
   * the run makes them, a chunk a drain, then fold the run into the
   * invocation, its error reported where the reader stands after it. jq_eval
   * prints them by the options, so an output --raw-output0 cannot print
   * stops the run with that error, as it does jq's.
   */
  private async *run(doc: string): AsyncGenerator<Uint8Array, void, undefined> {
    const ending: Ending = { stop: null }
    this.engine ??= await Engine.open(
      this.expr,
      this.opts,
      this.args,
      this.env,
      this.zone,
      this.origin,
      this.signal,
      true,
    )
    yield* this.engine.print(doc, this.reader, (line) => this.reports.push(line), ending)
    this.halted = this.settle(ending, this.reader.position())
  }

  // Fold one run into the invocation: its answer toward the exit status,
  // and its report when it stopped early. A halt ends the invocation, which
  // is what this answers.
  private settle(ending: Ending, position: string): boolean {
    this.statuses.push(runStatus(ending))
    if (ending.stop?.kind === 'error') {
      this.reports.push(errorReport(position, ending.stop))
    } else if (ending.stop?.kind === 'halt') {
      this.reports.push(haltReport(ending.stop))
      return true
    }
    return false
  }

  // jq's `ret = JQ_ERROR_UNKNOWN; break`, or under --seq a report that
  // leaves the status alone.
  private fail(failure: JqParseError): void {
    this.reports.push(parseReport(failure, this.opts))
    if (!this.opts.seq) this.statuses.push(ERROR_UNKNOWN)
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
  const expr = expression.trim()
  const reads = streamReads(expr)
  const readsStream = reads.input || reads.inputs
  const args = referencesArgs(expr) ? argsText(jq) : null
  // `$ENV` and `env` read the session's exported environment in place of
  // jq's process environment, and local time its `TZ`.
  const env = JSON.stringify(ctx.env ?? {})
  const zone = localZone(ctx.env)
  try {
    // jq compiles its program before it opens a single input, so a
    // refusal is all it prints. jq_eval words jq's refusals itself, reading
    // the program as typed, so its lines and columns are jq's. The run
    // compiles it again when it starts, so nothing is held open for a
    // stream no one reads.
    const checked = await Engine.open(expression, jq, args, env, zone, origin, ctx.signal)
    await checked.close()
  } catch (error) {
    if (!(error instanceof JqCompileError)) throw error
    return [
      null,
      new IOResult({
        exitCode: ERROR_COMPILE,
        stderr: new TextEncoder().encode(`${error.message}\n`),
      }),
    ]
  }

  const sources: InputSource[] = []
  // -n does not read its inputs at all unless the program asks for them
  // through `input` or `inputs`, which is why jq -n never opens a missing
  // file. Each input is opened when the reader reaches it, as jq opens its
  // files one after another.
  if (!jq.nullInput || readsStream) {
    if (paths.length > 0) {
      for (const path of paths) {
        sources.push({ name: inputName(path), chunks: readInput(path) })
      }
    } else if (ctx.stdin !== null) {
      sources.push({
        name: STDIN_NAME,
        chunks: readInput(PathSpec.fromStrPath('/dev/stdin')),
      })
    }
  }
  const io = new IOResult()
  const loop = new MainLoop(sources, expr, jq, args, env, zone, origin, io, ctx.signal)
  return [loop.outputs(), io]
}
