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

import { ByteSpool } from '../../../io/spool.ts'
import { OutputStream } from '../../../io/stream.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { stdinStream } from '../utils/stream.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { PathSpec } from '../../../types.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { shellQuote } from '../../../utils/quote.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { SortKeyError } from '../errors.ts'
import {
  buildConfig,
  compareLines,
  merged,
  parseKeydef,
  sortLines,
  type KeyMods,
  type SortConfig,
  type SortGlobals,
} from '../sort_keys.ts'
import { argmatchError } from '../../spec/usage.ts'
import { argmatch } from '../../spec/argmatch.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue, type ParsedFlagValue } from '../../spec/types.ts'
import { specOf } from '../../spec/builtins.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

export interface SortFlags extends SortGlobals {
  check: boolean
  checkQuiet: boolean
  merge: boolean
  output: PathSpec | null
  zeroTerminated: boolean
}

// `check_args` as gnulib's `argmatch_valid` prints it: `quiet` and
// `silent` map to the same value, so they share one `  - ` line.
const CHECK_ARGS: readonly (readonly string[])[] = [['quiet', 'silent'], ['diagnose-first']]

export const MULTIPLE_OUTPUTS = 'sort: multiple output files specified'

export const CHECK_MODES_CONFLICT = "sort: options '-cC' are incompatible"

const CHUNK = 128

const CHUNK_CHARS = 16 * 1024

// sort.c's `sort_die` prefixes. GNU tests every input with euidaccess(R_OK)
// before it reads any (`cannot read`), opens the output and the one input
// -c reads with open(2) (`open failed`), stats every input it is about to
// sort to size its buffer (`stat failed`), and only then reads (`read
// failed`).
export const CANNOT_READ = 'cannot read'
export const OPEN_FAILED = 'open failed'
export const STAT_FAILED = 'stat failed'
export const READ_FAILED = 'read failed'

const NO_MODS: KeyMods = {
  numeric: false,
  human: false,
  version: false,
  month: false,
  fold: false,
  reverse: false,
}

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

// GNU's `sort_die` line: the step, the name, then the errno.
export function sortDie(verb: string, label: string, strerror: string): Uint8Array {
  return ENC.encode(`sort: ${verb}: ${shellQuote(label)}: ${strerror}\n`)
}

function stageVerb(stage: InputStage, checking: boolean): string {
  if (stage === InputStage.READ) return READ_FAILED
  if (stage === InputStage.STAT) return STAT_FAILED
  return checking ? OPEN_FAILED : CANNOT_READ
}

function earliest(
  refused: [InputStage, Uint8Array] | null,
  stage: InputStage,
  line: Uint8Array,
): [InputStage, Uint8Array] {
  if (refused === null || stage < refused[0]) return [stage, line]
  return refused
}

// The check mode one check option asks for, as GNU's letter: `-c`, a bare
// `--check` and `--check=diagnose-first` are `c`; `-C` and `--check=quiet`
// (or `silent`) are `C`. A `--check` word argmatch refuses throws its
// UsageError, exit 1.
function checkMode(raw: ParsedFlagValue, dest: string): string {
  if (dest !== 'check') return dest
  if (raw === true) return 'c'
  const word = String(raw)
  const match = argmatch(word, CHECK_ARGS)
  if (!match.matched) throw argmatchError('sort', '--check', word, CHECK_ARGS, 1, match.kind)
  // The canonical word of the ['quiet', 'silent'] value is `quiet`, so
  // `--check=s` and `--check=silent` both land here.
  return match.word === 'quiet' ? 'C' : 'c'
}

// Validate every occurrence in scan order, before reading any inputs.
export function parseFlags(bag: Record<string, FlagValue>): SortFlags {
  const fl = new FlagView(bag, specOf('sort'))
  let mode: string | null = null
  let output: PathSpec | null = null
  // Each -o is the next word typed, and GNU compares two by that word
  // (STREQ), so `-o ./out -o out` names two outputs even though they are one
  // file. Mirrors sort.py.
  const typed = fl.asPaths('output')
  let next = 0
  for (const [dest, value] of fl.occurrences('key', 'output', 'c', 'C', 'check')) {
    if (dest === 'key' && typeof value === 'string') {
      parseKeydef(value, NO_MODS, false)
    } else if (dest === 'output') {
      const path = typed[next]
      next += 1
      if (path === undefined) continue
      if (output !== null && path.rawPath !== output.rawPath) {
        throw new UsageError(MULTIPLE_OUTPUTS)
      }
      output = path
    } else if (dest === 'check' || value === true) {
      const letter = checkMode(value, dest)
      if (mode !== null && letter !== mode) throw new UsageError(CHECK_MODES_CONFLICT)
      mode = letter
    }
  }
  return {
    reverse: fl.asBool('reverse'),
    numeric: fl.asBool('numeric_sort'),
    unique: fl.asBool('unique'),
    foldCase: fl.asBool('ignore_case'),
    keyDefs: fl.asList('key'),
    fieldSep: fl.asStr('field_separator') ?? null,
    humanNumeric: fl.asBool('human_numeric_sort'),
    versionSort: fl.asBool('version_sort'),
    monthSort: fl.asBool('month_sort'),
    ignoreBlanks: fl.asBool('ignore_leading_blanks'),
    stable: fl.asBool('stable'),
    generalNumeric: fl.asBool('general_numeric_sort'),
    dictionary: fl.asBool('dictionary_order'),
    ignoreNonprinting: fl.asBool('ignore_nonprinting'),
    check: mode !== null,
    checkQuiet: mode === 'C',
    merge: fl.asBool('merge'),
    output,
    zeroTerminated: fl.asBool('zero_terminated'),
  }
}

function refusalOf(error: unknown): IOResult {
  // Already GNU-worded and carrying its own code: gnulib's argmatch dies
  // with EXIT_FAILURE, so `--check=x` is 1 where sort's other usage errors
  // are 2.
  if (error instanceof UsageError) {
    return new IOResult({ exitCode: error.exitCode, stderr: ENC.encode(`${error.message}\n`) })
  }
  if (error instanceof SortKeyError) {
    return new IOResult({ exitCode: 2, stderr: ENC.encode(`sort: ${error.message}\n`) })
  }
  throw error
}

// What `-c` refuses in its operands, which GNU checks before reading. A
// second operand outranks an `-o`, and both name the check mode by its own
// letter, so `sort -C a b` is `not allowed with -C`.
export function operandRefusal(paths: readonly PathSpec[], parsed: SortFlags): IOResult | null {
  if (!parsed.check) return null
  const mode = parsed.checkQuiet ? 'C' : 'c'
  const extra = paths[1]
  if (extra !== undefined) {
    return new IOResult({
      exitCode: 2,
      stderr: ENC.encode(`sort: extra operand '${extra.rawPath}' not allowed with -${mode}\n`),
    })
  }
  if (parsed.output !== null) {
    return new IOResult({
      exitCode: 2,
      stderr: ENC.encode(`sort: options '-${mode}o' are incompatible\n`),
    })
  }
  return null
}

async function checkStream(
  source: ByteSource,
  path: PathSpec | null,
  parsed: SortFlags,
  cfg: SortConfig,
): Promise<IOResult> {
  const reader = new AsyncLineIterator(source)
  let previous: string | null = null
  let index = 0
  try {
    for (;;) {
      const raw = await reader.readline(undefined, parsed.zeroTerminated ? 0 : 10)
      if (raw === null) break
      const current = DEC.decode(raw)
      index++
      const comparison = previous !== null ? compareLines(previous, current, cfg) : -1
      if (comparison > 0 || (previous !== null && parsed.unique && comparison === 0)) {
        return new IOResult({
          exitCode: 1,
          stderr: parsed.checkQuiet
            ? null
            : ENC.encode(`sort: ${labelOf(path)}:${String(index)}: disorder: ${current}\n`),
        })
      }
      previous = current
    }
  } catch (error) {
    if (!isFsError(error)) throw error
    const strerror = fsStrerror(error) ?? String(error)
    const stage = inputStage(strerror, false)
    return new IOResult({
      exitCode: 2,
      stderr: sortDie(stageVerb(stage, true), labelOf(path), strerror),
    })
  } finally {
    await reader.discard()
  }
  return new IOResult()
}

function labelOf(path: PathSpec | null): string {
  return path === null ? '-' : path.rawPath
}

async function drain(lines: Iterable<string | null>, budget: YieldBudget): Promise<string[]> {
  const out: string[] = []
  for (const line of lines) {
    if (line !== null) out.push(line)
    await budget.run()
  }
  return out
}

function* chunked(records: string[]): Generator<string[], void, undefined> {
  let start = 0
  while (start < records.length) {
    let end = start + 1
    let size = records[start]?.length ?? 0
    while (
      end < records.length &&
      end - start < CHUNK &&
      size + (records[end]?.length ?? 0) <= CHUNK_CHARS
    ) {
      size += records[end]?.length ?? 0
      end += 1
    }
    yield records.slice(start, end)
    start = end
  }
}

/**
 * The records in output order, worked out on the loop. Sorting always ends,
 * so it needs no worker, only steps a YieldBudget paces: up to CHUNK records,
 * and CHUNK_CHARS characters unless one record alone is longer, sort as one
 * step, then the sorted chunks merge pairwise, a tie going to the
 * earlier chunk, which is the order one stable sort of every record gives,
 * `-u` included. Under `-m` the inputs merge as given. A large sort shares the
 * loop's core rather than using another (strukto-ai/mirage#1590).
 */
async function orderedRecords(
  runs: string[][],
  cfg: SortConfig,
  merge: boolean,
  signal?: AbortSignal,
): Promise<string[]> {
  const budget = new YieldBudget(signal)
  if (merge) return drain(merged(runs, cfg), budget)
  let chunks: string[][] = []
  for (const chunk of chunked(runs.flat())) {
    chunks.push(sortLines(chunk, cfg))
    await budget.run()
  }
  while (chunks.length > 1) {
    const paired: string[][] = []
    for (let i = 0; i < chunks.length; i += 2)
      paired.push(await drain(merged(chunks.slice(i, i + 2), cfg), budget))
    chunks = paired
  }
  return chunks[0] ?? []
}

export const SORT_RUN_BYTES = 8 * 1024 * 1024
const MERGE_FAN_IN = 16

async function mergeSpools(
  runs: ByteSpool[],
  cfg: SortConfig,
  separator: number,
  signal?: AbortSignal,
): Promise<ByteSpool> {
  const output = new ByteSpool(0)
  const readers = runs.map((run) => new AsyncLineIterator(run.stream()))
  const budget = new YieldBudget(signal)
  try {
    const heads: (Uint8Array | null)[] = []
    for (const reader of readers) heads.push(await reader.readline(signal, separator))
    let previous: string | null = null
    for (;;) {
      let chosen = -1
      let line = ''
      for (const [index, head] of heads.entries()) {
        if (head === null) continue
        const text = DEC.decode(head)
        if (chosen < 0 || compareLines(text, line, cfg) < 0) {
          chosen = index
          line = text
        }
      }
      if (chosen < 0) break
      if (!cfg.unique || previous === null || compareLines(previous, line, cfg) !== 0) {
        await output.append(ENC.encode(line + String.fromCharCode(separator)))
        previous = line
      }
      const reader = readers[chosen]
      if (reader === undefined) throw new Error('missing merge reader')
      heads[chosen] = await reader.readline(signal, separator)
      await budget.run()
    }
    return output
  } catch (error) {
    await output.close()
    throw error
  } finally {
    for (const reader of readers) await reader.discard()
    for (const run of runs) await run.close()
  }
}

async function externalRecords(
  paths: PathSpec[],
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
  stdin: ByteSource | null,
  parsed: SortFlags,
  cfg: SortConfig,
  signal?: AbortSignal,
): Promise<ByteSpool | Uint8Array> {
  const separator = parsed.zeroTerminated ? 0 : 10
  const ending = String.fromCharCode(separator)
  const levels: ByteSpool[][] = [[]]
  let refused: [InputStage, Uint8Array] | null = null
  let buffer: string[] = []
  let size = 0
  async function addRun(initial: ByteSpool): Promise<void> {
    let run = initial
    for (let level = 0; ; level++) {
      const group = levels[level] ?? (levels[level] = [])
      group.push(run)
      if (group.length < MERGE_FAN_IN) return
      levels[level] = []
      run = await mergeSpools(group, cfg, separator, signal)
    }
  }
  async function flush(): Promise<void> {
    if (buffer.length === 0) return
    const ordered = await orderedRecords([buffer], cfg, false, signal)
    const run = new ByteSpool()
    try {
      for (const line of ordered) await run.append(ENC.encode(line + ending))
      await addRun(run)
    } catch (error) {
      await run.close()
      throw error
    }
    buffer = []
    size = 0
  }
  try {
    const inputs: (PathSpec | null)[] = paths.length > 0 ? paths : [null]
    for (const path of inputs) {
      const reader = new AsyncLineIterator(
        path === null ? (stdin ?? new Uint8Array()) : stream(path),
      )
      let run: ByteSpool | null = parsed.merge ? new ByteSpool() : null
      try {
        for (;;) {
          const raw = await reader.readline(signal, separator)
          if (raw === null) break
          const text = DEC.decode(raw)
          if (run !== null) await run.append(ENC.encode(text + ending))
          else {
            buffer.push(text)
            size += raw.length + 64
            if (size >= SORT_RUN_BYTES) await flush()
          }
        }
        if (run !== null) {
          await addRun(run)
          run = null
        }
      } catch (error) {
        if (!isFsError(error)) throw error
        const strerror = fsStrerror(error) ?? String(error)
        const stage = inputStage(strerror, !parsed.merge)
        refused = earliest(
          refused,
          stage,
          sortDie(stageVerb(stage, false), labelOf(path), strerror),
        )
        if (stage === InputStage.ACCESS) break
      } finally {
        await reader.discard()
        if (run !== null) await run.close()
      }
    }
    if (refused !== null) return refused[1]
    await flush()
    let runs = [...levels].reverse().flat()
    while (runs.length > 1) {
      const next: ByteSpool[] = []
      for (let start = 0; start < runs.length; start += MERGE_FAN_IN) {
        const mergedRun = await mergeSpools(
          runs.slice(start, start + MERGE_FAN_IN),
          cfg,
          separator,
          signal,
        )
        levels.push([mergedRun])
        next.push(mergedRun)
      }
      runs = next
    }
    let output = runs[0] ?? new ByteSpool()
    if (parsed.merge && cfg.unique) output = await mergeSpools([output], cfg, separator, signal)
    for (const level of levels) for (const run of level) if (run !== output) await run.close()
    levels.length = 0
    return output
  } finally {
    for (const level of levels) for (const run of level) await run.close()
  }
}

// GNU sort over the given inputs. The refusals come in GNU's order: the
// option loop's, then with `-c` a second operand and an `-o`, then the
// inputs, and last the output. Deliberate divergence: GNU opens `-o` before
// it reads any input and this writes it once every input has been read, so
// when an input fails only at its stat or its read (a directory), GNU
// reports an unopenable output first and leaves a new one behind empty, and
// this reports the input and writes nothing. An output is named by the
// word typed, as GNU echoes it. Mirrors sort in sort.py.
export async function sortGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
  write?: (path: PathSpec, data: ByteSource) => Promise<void>,
): Promise<CommandFnResult> {
  stream = stdinStream(stream, opts.stdin)
  let parsed: SortFlags
  let cfg: SortConfig
  try {
    parsed = parseFlags(opts.flags)
    cfg = buildConfig(parsed)
  } catch (error) {
    return [new Uint8Array(), refusalOf(error)]
  }
  const refusal = operandRefusal(paths, parsed)
  if (refusal !== null) return [new Uint8Array(), refusal]
  if (parsed.check) {
    const path = paths[0] ?? null
    return [
      new Uint8Array(),
      await checkStream(
        path === null ? (opts.stdin ?? new Uint8Array()) : stream(path),
        path,
        parsed,
        cfg,
      ),
    ]
  }
  const ordered = await externalRecords(paths, stream, opts.stdin, parsed, cfg, opts.signal)
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
      vfsPath: mountKey(parsed.output.virtual, opts.mountPrefix ?? ''),
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
          stderr: sortDie(OPEN_FAILED, parsed.output.rawPath, strerror),
        }),
      ]
    } finally {
      await ordered.close()
    }
    return [new Uint8Array(), new IOResult()]
  }
  return [new OutputStream(ordered.stream(), () => ordered.close()), new IOResult()]
}
