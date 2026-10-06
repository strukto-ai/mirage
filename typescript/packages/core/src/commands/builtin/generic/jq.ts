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
  formatJqOutput,
  haltReport,
  jqCheck,
  jqOptions,
  jqRunTexts,
  loadFailure,
  printable,
  readTexts,
  referencesArgs,
  streamReads,
  stringText,
  valueText,
  type InputSource,
  type JqOptions,
  type JqRun,
  type StreamReads,
} from '../../../core/jq/index.ts'
import { yieldBytes } from '../../../io/stream.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { isFsError } from '../../../errors/fs.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { type CommandFnResult, type CommandOpts } from '../../config.ts'
import { helpPage, versionLine } from '../../spec/standard.ts'
import { UsageError } from '../../errors.ts'
import { isStdin, stdinStream } from '../utils/stream.ts'
import { programFileRefusal, readProgramFile } from './program.ts'

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

const DEC = new TextDecoder()
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

// The outputs -e counts as null-kind, as jq dumps them.
const NULL_KIND = new Set(['null', 'false'])

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

/** Read a pair option's flattened values back as [name, value]. */
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
export function positionalValue(mode: Mode, word: string): string {
  if (mode === 'args') return stringText(word)
  const text = valueText(ENC.encode(word))
  if (text === NO_VALUE) {
    throw new UsageError(`jq: invalid JSON text passed to --jsonargs\n${USAGE_HINT}`, 2)
  }
  return text
}

/**
 * A path pair option's [name, file] pairs, each file the PathSpec of the
 * word that spelled it, or one built from its resolved path.
 */
function pathPairs(
  fl: FlagView,
  option: string,
  toSpec: (value: string) => PathSpec,
): [string, PathSpec][] {
  const raw = fl.raw(option)
  if (!Array.isArray(raw)) return []
  const items: readonly (string | PathSpec)[] = raw
  const pairs: [string, PathSpec][] = []
  for (let i = 0; i + 1 < items.length; i += 2) {
    const name = items[i]
    const file = items[i + 1]
    if (typeof name !== 'string' || file === undefined) continue
    pairs.push([name, file instanceof PathSpec ? file : toSpec(file)])
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
    const text = valueText(ENC.encode(value))
    if (text === NO_VALUE) {
      throw new UsageError(`jq: invalid JSON text passed to --argjson\n${USAGE_HINT}`, 2)
    }
    return text
  }
  const data = await loadFile(read, dest, name, value)
  if (dest === 'rawfile') return stringText(decodeUtf8(data))
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
  toSpec: (value: string) => PathSpec,
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
    rawfile: pathPairs(fl, 'rawfile', toSpec).values(),
    slurpfile: pathPairs(fl, 'slurpfile', toSpec).values(),
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
        if (word.done !== true) positional.push(positionalValue(mode, word.value))
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
  if (mode !== null) for (const word of words) positional.push(positionalValue(mode, word))
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

/** What jq's process() answers for one run, its outputs jq's compact dumps. */
export function runStatus(run: JqRun<string>): number {
  if (run.stop?.kind === 'halt') return run.stop.code === null ? OK : Math.trunc(run.stop.code)
  if (run.stop?.kind === 'error') return ERROR_UNKNOWN
  if (run.outputs.length === 0) return OK_NO_OUTPUT
  return NULL_KIND.has(run.outputs[run.outputs.length - 1] ?? '') ? OK_NULL_KIND : OK
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
 * A run of a program that calls `input` or `inputs` reads what they take
 * before the program runs (see run), and nothing past it, so the loop never
 * reads further ahead than jq's own.
 *
 * An input that cannot be opened or read is reported when the reader reaches
 * it, and the reader goes on to the next. The loop checks for such a failure
 * before each document it reads, so it stops after the run of the document
 * the failing read went on to, and the exit status is 2 whatever the runs
 * answered. `sources` are the inputs, in order, not yet opened.
 */
export class MainLoop {
  private readonly statuses: number[] = []
  private readonly reports: string[] = []
  private readonly reader: InputReader

  constructor(
    sources: readonly InputSource[],
    private readonly expr: string,
    private readonly opts: JqOptions,
    private readonly reads: StreamReads,
    private readonly args: string | null,
    private readonly io: IOResult,
  ) {
    this.reader = new InputReader(sources, opts, (line) => this.reports.push(line))
  }

  /** The invocation's stdout, run by run. */
  async *outputs(): AsyncIterable<Uint8Array> {
    try {
      if (this.opts.nullInput) {
        const [run, position] = await this.run('null', this.reader.position())
        if (run.outputs.length > 0) yield formatJqOutput(run.outputs, this.opts)
        this.settle(run, position)
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
        const [run, position] = await this.run(item, this.reader.position())
        if (run.outputs.length > 0) yield formatJqOutput(run.outputs, this.opts)
        if (this.settle(run, position)) return
      }
    } finally {
      this.io.exitCode =
        this.reader.failures() > 0 ? ERROR_SYSTEM : exitCode(this.statuses, this.opts)
      if (this.reports.length > 0) this.io.stderr = ENC.encode(this.reports.join(''))
      await this.reader.close()
    }
  }

  /**
   * Run the program on one document (null under -n), and say where the
   * reader stands after it, for its error report; `position` is where it
   * stood once it had read the document. The run is what jq's main loop gets
   * to print (see printable).
   *
   * `input` and `inputs` consume the stream the main loop reads, so a run
   * reads what they take first, and the next run starts past it. How much a
   * run takes is a runtime fact this evaluator does not report, so mirage
   * assumes what the idioms do: `inputs` drains the rest (`[., inputs]`,
   * `reduce inputs as $x`), and `input` alone takes one (`[., input]` pairs
   * the documents up). A program that takes some other count
   * (`first(inputs)`, an `input` in a branch not taken) leaves real jq a
   * different remainder for its next run than here. A parse error stops the
   * reading: the run raises it where `input` or `inputs` would reach it, and
   * the main loop reads on past it.
   */
  private async run(doc: string, position: string): Promise<[JqRun<string>, string]> {
    const reads = this.reads
    if (!reads.input && !reads.inputs) {
      const run = await jqRunTexts(doc, this.expr, this.opts.namedArgs, null, this.args)
      return [printable(run, this.opts), position]
    }
    const docs: string[] = []
    let failure: JqParseError | null = null
    let at = position
    for (;;) {
      const item = await this.reader.nextInput()
      at = this.reader.position()
      if (item === NO_VALUE) break
      if (item instanceof JqParseError) {
        failure = item
        break
      }
      docs.push(item)
      if (!reads.inputs) break
    }
    const run = await jqRunTexts(
      doc,
      this.expr,
      this.opts.namedArgs,
      docs,
      this.args,
      failure === null ? null : failure.message,
    )
    return [printable(run, this.opts), at]
  }

  // Fold one run into the invocation: its answer toward the exit status,
  // and its report when it stopped early. A halt ends the invocation, which
  // is what this answers.
  private settle(run: JqRun<string>, position: string): boolean {
    this.statuses.push(runStatus(run))
    if (run.stop?.kind === 'error') {
      this.reports.push(errorReport(position, run.stop))
    } else if (run.stop?.kind === 'halt') {
      this.reports.push(haltReport(run.stop))
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

// Path flags arrive as resolved virtual-path strings, so a flag that
// names a file builds its own PathSpec against the operands' mount.
function pathSpecFactory(
  paths: readonly PathSpec[],
  opts: CommandOpts,
): (value: string) => PathSpec {
  const first = paths[0]
  const mountPrefix =
    (first === undefined ? undefined : mountPrefixOf(first.virtual, first.vfsPath)) ??
    opts.mountPrefix ??
    ''
  return (value) => PathSpec.fromStrPath(value, mountKey(value, mountPrefix))
}

/** The file -f names, as the word typed when the bag kept it. */
function programFileOf(fl: FlagView, toSpec: (value: string) => PathSpec): PathSpec | null {
  const raw = fl.raw('from_file')
  if (raw instanceof PathSpec) return raw
  return typeof raw === 'string' ? toSpec(raw) : null
}

export async function jqGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  const readInput = stdinStream(stream, opts.stdin)
  const fl = new FlagView(opts.flags, specOf('jq'))
  const toSpec = pathSpecFactory(paths, opts)
  const programFile = programFileOf(fl, toSpec)
  // -f, --rawfile and --slurpfile route nothing (the executor's FILE_KEYS and
  // DOOR_FLAG_KEYS), so a file may sit on another mount than the operands: it
  // is read through the door. jq opens it by name, so /dev/stdin is the
  // invocation's own stdin and `-` is a file named `-`.
  const readFlagFile = (path: PathSpec): Promise<Uint8Array> => {
    if (isStdin(path, false)) return materialize(readInput(path))
    if (opts.dispatch === undefined) return materialize(stream(path))
    return readProgramFile('jq', path, opts.dispatch)
  }
  // jq reads its options before its program, so a refused option is reported
  // before an -f file is read.
  const jq = await readOptions(fl, texts, programFile !== null, toSpec, readFlagFile)
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
  const expr = expression.trim()
  const reads = streamReads(expr)
  const readsStream = reads.input || reads.inputs
  const args = referencesArgs(expr) ? argsText(jq) : null
  try {
    await jqCheck(expr, jq.namedArgs, readsStream ? [] : null, args)
  } catch (error) {
    if (!(error instanceof JqCompileError)) throw error
    // jq compiles its program before it opens a single input, so a
    // refusal is all it prints.
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
    } else if (opts.stdin !== null) {
      sources.push({
        name: STDIN_NAME,
        chunks: readInput(PathSpec.fromStrPath('/dev/stdin')),
      })
    }
  }
  const io = new IOResult()
  const loop = new MainLoop(sources, expr, jq, reads, args, io)
  return [loop.outputs(), io]
}
