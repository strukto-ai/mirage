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

import { chunks } from '../../../io/cooperative.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { drain } from '../../../io/stream.ts'
import { stdinStream } from '../utils/stream.ts'
import { recordSeparator } from '../utils/lines.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import {
  chainOutput,
  closeStream,
  openStream,
  runStream,
  type OpenStream,
} from '../../../rs/stream.ts'
import { PathSpec, type JsonValue } from '../../../types.ts'
import { concat } from '../../../utils/bytes.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { shellQuote } from '../../../utils/quote.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { refused, scan } from '../../../rs/scan.ts'
import { OPERAND } from '../../spec/constants.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()

export interface SortFlags {
  /** The engine's configuration, as mirage-rs read it. */
  config: Record<string, JsonValue>
  check: boolean
  checkQuiet: boolean
  merge: boolean
  output: PathSpec | null
  zeroTerminated: boolean
}

// The options sort's grammar in mirage-rs reads.
const GRAMMAR = [
  'reverse',
  'numeric_sort',
  'general_numeric_sort',
  'human_numeric_sort',
  'version_sort',
  'month_sort',
  'ignore_case',
  'dictionary_order',
  'ignore_nonprinting',
  'ignore_leading_blanks',
  'unique',
  'stable',
  'zero_terminated',
  'field_separator',
  'key',
  'output',
  'c',
  'C',
  'check',
] as const

// The steps GNU sort names when a file fails it. GNU checks that every input
// is readable before it reads any (`cannot read`), opens the output and the
// one input -c reads (`open failed`), stats every input it is about to sort
// (`stat failed`), and only then reads (`read failed`).
export const CANNOT_READ = 'cannot read'
export const OPEN_FAILED = 'open failed'
export const STAT_FAILED = 'stat failed'
export const READ_FAILED = 'read failed'

// The step at which GNU sort first meets an input's failure, declared in
// the order GNU takes the steps, so the value is also the precedence: sort
// runs every input through one step before it moves any of them to the
// next, and a missing second input is reported ahead of an unreadable
// first one. Mirrors InputStage in sort.py.
export enum InputStage {
  ACCESS = 0,
  STAT = 1,
  READ = 2,
}

// Which step an input failure belongs to, told by its strerror.
// euidaccess(R_OK) passes a directory, so GNU meets one only when the read
// of it fails, and a mount's record cap refuses the same way. A closed
// standard input fails the fstat plain sort takes of every input before
// reading, but `-m` and `-c` never stat and fail on the read instead.
// Classified by the strerror a renderer wrote, so the stream path, which
// only holds a rendered line, sorts a failure into the same step as a
// command holding the error. Mirrors input_stage in sort.py.
export function inputStage(strerror: string, sorting: boolean): InputStage {
  if (strerror === posixPhrase('EBADF')) return sorting ? InputStage.STAT : InputStage.READ
  for (const code of ['EISDIR', 'EFBIG'] as const) {
    if (strerror === posixPhrase(code)) return InputStage.READ
  }
  return InputStage.ACCESS
}

// GNU sort's line for a failed step: the step, the name, the errno.
export function stepFailure(verb: string, label: string, strerror: string): Uint8Array {
  return ENC.encode(`sort: ${verb}: ${shellQuote(label)}: ${strerror}\n`)
}

function stageVerb(stage: InputStage, checking: boolean): string {
  if (stage === InputStage.READ) return READ_FAILED
  if (stage === InputStage.STAT) return STAT_FAILED
  return checking ? OPEN_FAILED : CANNOT_READ
}

function earliest(
  firstFailure: [InputStage, Uint8Array] | null,
  stage: InputStage,
  line: Uint8Array,
): [InputStage, Uint8Array] {
  if (firstFailure === null || stage < firstFailure[0]) return [stage, line]
  return firstFailure
}

// sort's options in the order typed, then its operands. An output is the word
// typed, which GNU compares (STREQ), so `-o ./out -o out` names two outputs
// though they are one file, and a bare `--check` is `-c`, apart from
// `--check=`'s empty word. The tape holds each `-o` resolved, so its word
// comes from the path the line typed in the same place; throws when the tape
// holds other `-o` words than the paths. Mirrors _typed_options in sort.py.
function typedOptions(fl: FlagView, paths: readonly PathSpec[]): [string, string][] {
  const tape = fl.occurrences(...GRAMMAR)
  const outputs = fl.asPaths('output')
  if (tape.filter(([name]) => name === 'output').length !== outputs.length) {
    throw new Error(`sort's tape holds other -o words than its ${String(outputs.length)} paths`)
  }
  const words = outputs.map((path) => path.rawPath)[Symbol.iterator]()
  const typed: [string, string][] = []
  for (const [name, value] of tape) {
    if (name === 'output') {
      typed.push([name, words.next().value ?? ''])
    } else if (value === true) {
      typed.push([name === 'check' ? 'c' : name, ''])
    } else if (typeof value === 'string') {
      typed.push([name, value])
    }
  }
  for (const path of paths) typed.push([OPERAND, path.rawPath])
  return typed
}

/**
 * The configuration a sort scan read, which every sort engine takes; throws
 * when the scan read none. Mirrors engine_config in sort.py.
 */
export function engineConfig(values: Record<string, JsonValue>): Record<string, JsonValue> {
  const config = values.config
  if (
    typeof config === 'object' &&
    config !== null &&
    !Array.isArray(config) &&
    typeof config.zero_terminated === 'boolean'
  ) {
    return config
  }
  throw new Error(`sort's scan read no config: ${JSON.stringify(values)}`)
}

/**
 * Read sort's options and operands in mirage-rs, before any input: what the
 * options decide, or what GNU sort refuses first, exit 1 for a refused
 * `--check` word and 2 for the rest. Throws when the scan read no
 * configuration or check mode. Mirrors parse_flags in sort.py.
 */
export function parseFlags(
  bag: Record<string, FlagValue>,
  paths: readonly PathSpec[],
): SortFlags | IOResult {
  const fl = new FlagView(bag, specOf('sort'))
  let values: Record<string, JsonValue>
  try {
    values = scan('sort', typedOptions(fl, paths))
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    return refused(error)
  }
  const config = engineConfig(values)
  const check = values.check
  if (check !== null && check !== 'c' && check !== 'C') {
    throw new Error(`sort's scan read no check mode: ${JSON.stringify(check)}`)
  }
  const outputs = fl.asPaths('output')
  return {
    config,
    check: check !== null,
    checkQuiet: check === 'C',
    merge: fl.asBool('merge'),
    output: outputs[outputs.length - 1] ?? null,
    zeroTerminated: config.zero_terminated === true,
  }
}

async function checkStream(
  source: ByteSource,
  path: PathSpec | null,
  parsed: SortFlags,
  signal?: AbortSignal,
): Promise<IOResult> {
  const config = { ...parsed.config, mode: 'check' }
  try {
    await drain(runStream('sort', config, source, signal))
  } catch (error) {
    // The refusal's message is the record's number, its output the record,
    // which GNU writes with its own terminator.
    if (error instanceof StreamRefusal) {
      return new IOResult({
        exitCode: 1,
        stderr: parsed.checkQuiet
          ? null
          : concat([
              ENC.encode(`sort: ${label(path)}:${error.message}: disorder: `),
              error.output,
              Uint8Array.of(recordSeparator(parsed.zeroTerminated)),
            ]),
      })
    }
    if (!isFsError(error)) throw error
    const strerror = fsStrerror(error) ?? String(error)
    const stage = inputStage(strerror, false)
    return new IOResult({
      exitCode: 2,
      stderr: stepFailure(stageVerb(stage, true), label(path), strerror),
    })
  }
  return new IOResult()
}

function label(path: PathSpec | null): string {
  return path === null ? '-' : path.rawPath
}

// A run is sorted once its records reach SORT_RUN_BYTES, each counting its
// length plus 64, and spooled; MERGE_FAN_IN runs merge into one at a time,
// so a sort of any size holds one run and one chunk per merged input.
export const SORT_RUN_BYTES = 8 * 1024 * 1024
const MERGE_FAN_IN = 16

// A k-way merge of sorted spools, each read as the merge asks; the runs
// are closed once merged. Mirrors _merge_spools in sort.py.
async function mergeSpools(
  runs: ByteSpool[],
  config: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
): Promise<ByteSpool> {
  const output = new ByteSpool()
  const engine = await openStream('sort', { ...config, mode: 'merge', inputs: runs.length })
  try {
    await output.fill(
      chainOutput(
        engine,
        runs.map((run) => run.stream()),
        signal,
      ),
    )
    return output
  } catch (error) {
    await output.close()
    throw error
  } finally {
    await closeStream(engine)
    for (const run of runs) await run.close()
  }
}

async function addRun(
  levels: ByteSpool[][],
  initial: ByteSpool,
  config: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
): Promise<void> {
  let run = initial
  for (let level = 0; ; level++) {
    const group = levels[level] ?? (levels[level] = [])
    group.push(run)
    if (group.length < MERGE_FAN_IN) return
    levels[level] = []
    run = await mergeSpools(group, config, signal)
  }
}

async function mergeOperands(
  paths: PathSpec[],
  read: (path: PathSpec) => AsyncIterable<Uint8Array>,
  stdin: ByteSource | null,
  config: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
): Promise<ByteSpool | Uint8Array> {
  const stream = stdinStream(read, stdin)
  const state: { firstFailure: [InputStage, Uint8Array] | null } = { firstFailure: null }
  const levels: ByteSpool[][] = [[]]
  async function* source(path: PathSpec | null): AsyncGenerator<Uint8Array> {
    try {
      yield* chunks(path === null ? (stdin ?? new Uint8Array()) : stream(path), signal)
    } catch (err) {
      if (!isFsError(err)) throw err
      const strerror = fsStrerror(err) ?? String(err)
      const stage = inputStage(strerror, false)
      state.firstFailure = earliest(
        state.firstFailure,
        stage,
        stepFailure(stageVerb(stage, false), label(path), strerror),
      )
    }
  }
  try {
    const operands = paths.length > 0 ? paths : [null]
    for (let start = 0; start < operands.length; start += MERGE_FAN_IN) {
      const group = operands.slice(start, start + MERGE_FAN_IN)
      const engine = await openStream('sort', { ...config, mode: 'merge', inputs: group.length })
      const output = new ByteSpool()
      try {
        await output.fill(
          chainOutput(
            engine,
            group.map((path) => source(path)),
            signal,
          ),
        )
        await addRun(levels, output, config, signal)
      } catch (error) {
        await output.close()
        throw error
      } finally {
        await closeStream(engine)
      }
    }
    if (state.firstFailure !== null) return state.firstFailure[1]
    const runs = [...levels].reverse().flat()
    while (runs.length > 1) {
      const group = runs.slice(0, MERGE_FAN_IN)
      const merged = await mergeSpools(group, config, signal)
      levels.push([merged])
      runs.splice(0, group.length, merged)
    }
    const output = runs.pop() ?? new ByteSpool()
    for (const level of levels) for (const run of level) if (run !== output) await run.close()
    levels.length = 0
    return output
  } finally {
    for (const level of levels) for (const run of level) await run.close()
  }
}

async function externalRecords(
  paths: PathSpec[],
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
  stdin: ByteSource | null,
  parsed: SortFlags,
  signal?: AbortSignal,
): Promise<ByteSpool | Uint8Array> {
  const separator = recordSeparator(parsed.zeroTerminated)
  const config = parsed.config
  if (parsed.merge) return mergeOperands(paths, stream, stdin, config, signal)
  const levels: ByteSpool[][] = [[]]
  let firstFailure: [InputStage, Uint8Array] | null = null
  const budget = new YieldBudget(signal)
  const sorter = await openStream('sort', { ...config, mode: 'sort', run_bytes: SORT_RUN_BYTES })
  // While the stream is busy each drain is one bounded step of a run and
  // what it writes belongs to that run, so the loop yields between steps; a
  // feed of no bytes then starts a run already buffered.
  async function addSorted(stream: OpenStream): Promise<void> {
    while (stream.busy()) {
      const run = new ByteSpool()
      try {
        while (stream.busy()) {
          const piece = stream.drain()
          if (piece.byteLength > 0) await run.append(piece)
          await budget.run()
        }
        await addRun(levels, run, config, signal)
      } catch (error) {
        await run.close()
        throw error
      }
      stream.feed(new Uint8Array())
    }
  }
  try {
    const inputs: (PathSpec | null)[] = paths.length > 0 ? paths : [null]
    for (const path of inputs) {
      const source = path === null ? (stdin ?? new Uint8Array()) : stream(path)
      let last = separator
      try {
        for await (const chunk of chunks(source, signal)) {
          if (chunk.byteLength === 0) continue
          last = chunk[chunk.byteLength - 1] ?? separator
          sorter.feed(chunk)
          await addSorted(sorter)
        }
        // Each input's last record ends at its end, as GNU reads it.
        if (last !== separator) {
          sorter.feed(Uint8Array.of(separator))
          await addSorted(sorter)
        }
      } catch (error) {
        if (!isFsError(error)) throw error
        const strerror = fsStrerror(error) ?? String(error)
        const stage = inputStage(strerror, true)
        firstFailure = earliest(
          firstFailure,
          stage,
          stepFailure(stageVerb(stage, false), label(path), strerror),
        )
        if (stage === InputStage.ACCESS) break
      }
    }
    if (firstFailure !== null) return firstFailure[1]
    sorter.finish()
    await addSorted(sorter)
    let runs = [...levels].reverse().flat()
    while (runs.length > 1) {
      const next: ByteSpool[] = []
      for (let start = 0; start < runs.length; start += MERGE_FAN_IN) {
        const mergedRun = await mergeSpools(runs.slice(start, start + MERGE_FAN_IN), config, signal)
        levels.push([mergedRun])
        next.push(mergedRun)
      }
      runs = next
    }
    const output = runs[0] ?? new ByteSpool()
    for (const level of levels) for (const run of level) if (run !== output) await run.close()
    levels.length = 0
    return output
  } finally {
    await closeStream(sorter)
    for (const level of levels) for (const run of level) await run.close()
  }
}

// GNU sort over the given inputs. The refusals come in GNU's order: what
// mirage-rs refuses in the options and the operands, then the inputs, and
// last the output. Deliberate divergence: GNU opens `-o` before
// it reads any input and this writes it once every input has been read, so
// when an input fails only at its stat or its read (a directory), GNU
// reports an unopenable output first and leaves a new one behind empty, and
// this reports the input and writes nothing. An output is named by the
// word typed, as GNU echoes it. Mirrors sort in sort.py.
export async function sortGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
  write?: (path: PathSpec, data: ByteSource) => Promise<void>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, ctx.stdin)
  const parsed = parseFlags(ctx.flags, paths)
  if (parsed instanceof IOResult) return [new Uint8Array(), parsed]
  if (parsed.check) {
    const path = paths[0] ?? null
    return [
      new Uint8Array(),
      await checkStream(
        path === null ? (ctx.stdin ?? new Uint8Array()) : stream(path),
        path,
        parsed,
        ctx.signal,
      ),
    ]
  }
  const ordered = await externalRecords(paths, stream, ctx.stdin, parsed, ctx.signal)
  if (ordered instanceof Uint8Array)
    return [new Uint8Array(), new IOResult({ exitCode: 2, stderr: ordered })]
  if (parsed.output !== null) {
    if (write === undefined) {
      await ordered.close()
      return [
        new Uint8Array(),
        new IOResult({
          exitCode: 2,
          stderr: ENC.encode('sort: output is not writable on this backend\n'),
        }),
      ]
    }
    const outputPath = new PathSpec({
      virtual: parsed.output.virtual,
      directory: parsed.output.directory,
      vfsPath: stripSlash(parsed.output.virtual),
      rawPath: parsed.output.rawPath,
      dotted: parsed.output.dotted,
      walkError: parsed.output.walkError,
    })
    try {
      await write(outputPath, ordered.stream())
    } catch (error) {
      if (!isFsError(error)) throw error
      const strerror = fsStrerror(error) ?? String(error)
      return [
        new Uint8Array(),
        new IOResult({
          exitCode: 2,
          stderr: stepFailure(OPEN_FAILED, parsed.output.rawPath, strerror),
        }),
      ]
    } finally {
      await ordered.close()
    }
    return [new Uint8Array(), new IOResult()]
  }
  return [await ordered.output(), new IOResult()]
}
