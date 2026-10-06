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

import { stdinStream } from '../utils/stream.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { fsStrerror, gnuStrerror, isFsError } from '../../../utils/errors.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { shellQuote } from '../../../utils/quote.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { SortKeyError } from '../errors.ts'
import {
  buildConfig,
  compareLines,
  mergeLines,
  parseKeydef,
  sortLines,
  type KeyMods,
  type SortConfig,
  type SortGlobals,
} from '../sort_keys.ts'
import { splitLines } from '../utils/lines.ts'
import { readStdinAsync } from '../utils/stream.ts'
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
  if (strerror === gnuStrerror('EBADF')) return sorting ? InputStage.STAT : InputStage.READ
  for (const code of ['EISDIR', 'EFBIG']) {
    if (strerror === gnuStrerror(code)) return InputStage.READ
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

function splitRecords(raw: Uint8Array, zeroTerminated: boolean): string[] {
  if (!zeroTerminated) return splitLines(DEC.decode(raw))
  const records: string[] = []
  let start = 0
  for (let index = 0; index < raw.byteLength; index++) {
    if (raw[index] === 0) {
      records.push(DEC.decode(raw.subarray(start, index)))
      start = index + 1
    }
  }
  if (start < raw.byteLength) records.push(DEC.decode(raw.subarray(start)))
  return records
}

function checkRecords(records: readonly string[], cfg: SortConfig, unique: boolean): number | null {
  for (let index = 1; index < records.length; index++) {
    const previous = records[index - 1]
    const current = records[index]
    if (previous === undefined || current === undefined) continue
    const comparison = compareLines(previous, current, cfg)
    if (comparison > 0 || (unique && comparison === 0)) return index
  }
  return null
}

function labelOf(path: PathSpec | null): string {
  return path === null ? '-' : path.rawPath
}

// Every input's records, one run per input, or the line refusing one. Each
// input is split on its own, so a file that lacks a final newline still
// ends its last line there instead of running into the next file's first,
// and `-m` gets the runs it merges. GNU takes every input through one step
// before any through the next, so the failure reported is the first of the
// earliest step any input failed at: a directory does not stop the later
// inputs from being tried, and the first input to fail its access check
// ends the run, since nothing after it can outrank that. Mirrors
// _read_runs in sort.py.
async function readRuns(
  paths: readonly PathSpec[],
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
  stdin: ByteSource | null,
  parsed: SortFlags,
): Promise<string[][] | Uint8Array> {
  const sorting = !parsed.check && !parsed.merge
  const runs: string[][] = []
  let refused: [InputStage, Uint8Array] | null = null
  const inputs: (PathSpec | null)[] = paths.length > 0 ? [...paths] : [null]
  for (const path of inputs) {
    let raw: Uint8Array
    try {
      raw =
        path === null
          ? ((await readStdinAsync(stdin)) ?? new Uint8Array())
          : await materialize(stream(path))
    } catch (error) {
      if (!isFsError(error)) throw error
      const strerror = fsStrerror(error) ?? String(error)
      const stage = inputStage(strerror, sorting)
      refused = earliest(
        refused,
        stage,
        sortDie(stageVerb(stage, parsed.check), labelOf(path), strerror),
      )
      if (stage === InputStage.ACCESS) break
      continue
    }
    runs.push(splitRecords(raw, parsed.zeroTerminated))
  }
  return refused !== null ? refused[1] : runs
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
  write?: (path: PathSpec, data: Uint8Array) => Promise<void>,
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
  const runs = await readRuns(paths, stream, opts.stdin, parsed)
  if (runs instanceof Uint8Array)
    return [new Uint8Array(), new IOResult({ exitCode: 2, stderr: runs })]
  if (parsed.check) {
    const records = runs[0] ?? []
    const disorder = checkRecords(records, cfg, parsed.unique)
    if (disorder === null) return [new Uint8Array(), new IOResult()]
    if (parsed.checkQuiet) return [new Uint8Array(), new IOResult({ exitCode: 1 })]
    const label = labelOf(paths[0] ?? null)
    const line = records[disorder] ?? ''
    return [
      new Uint8Array(),
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode(`sort: ${label}:${String(disorder + 1)}: disorder: ${line}\n`),
      }),
    ]
  }
  const ordered = parsed.merge ? mergeLines(runs, cfg) : sortLines(runs.flat(), cfg)
  const separator = parsed.zeroTerminated ? '\0' : '\n'
  const output: Uint8Array =
    ordered.length === 0 ? new Uint8Array() : ENC.encode(ordered.join(separator) + separator)
  if (parsed.output !== null) {
    if (write === undefined) {
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
      await write(outputPath, output)
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
    }
    return [
      new Uint8Array(),
      new IOResult({ writes: { [outputPath.mountPath]: output }, cache: [outputPath.mountPath] }),
    ]
  }
  const out: ByteSource = output
  return [out, new IOResult()]
}
