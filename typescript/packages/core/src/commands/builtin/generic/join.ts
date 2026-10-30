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

import { OutputStream } from '../../../io/stream.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { specOf } from '../../spec/builtins.ts'
import { OPERAND, SPELLED } from '../../spec/constants.ts'
import { FlagView, spreadOperands } from '../../spec/flag_view.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { missingOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { byteView, encodeText } from '../../../shell/bytes.ts'
import { closeStream, mergeOutput, openStream, type OpenStream } from '../../../rs/stream.ts'
import { concat } from '../../../utils/bytes.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import type { JsonValue } from '../../../types.ts'
import { isStdin, neverOpened, stdinStream } from '../utils/stream.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'

const OPTION_DESTS = [
  'a',
  'v',
  'e',
  'ignore_case',
  'args_1',
  '2',
  'j',
  'o',
  't',
  'zero_terminated',
  'check_order',
  'nocheck_order',
  'header',
]

/**
 * What join does with a line whose key sorts before the one above it. WARN,
 * the default, names the first such line of each file, but only once some
 * line has gone unpaired, then finishes and exits 1 under `input is not in
 * sorted order`. FAIL (`--check-order`) names the first one and stops there.
 * OFF (`--nocheck-order`) never looks. Mirrors OrderCheck in join.py.
 */
export enum OrderCheck {
  WARN = 'warn',
  FAIL = 'fail',
  OFF = 'off',
}

/** A -o item: a file number and a field counted from 0; file 0 is the join field. */
export type Column = readonly [number, number]

/**
 * join's options as one line set them; every byte string is a byte view, one
 * character per byte. Mirrors JoinFlags in join.py.
 */
export interface JoinFlags {
  /** Each file's join field, counted from 0. */
  readonly keys: readonly [number, number]
  /** Whether each file's unpairable lines print (-a, -v). */
  readonly unpaired: readonly [boolean, boolean]
  /** Whether joined lines print; any -v clears it. */
  readonly paired: boolean
  /** The -e text for an empty field. */
  readonly filler: string | null
  /** The -o list. */
  readonly columns: readonly Column[]
  /** -o auto. */
  readonly autoColumns: boolean
  /** The -t byte; null parts fields at runs of blanks, WHOLE_RECORD keeps each record whole. */
  readonly delimiter: string | null
  /** What output fields are joined with. */
  readonly separator: string
  /** -i. */
  readonly foldCase: boolean
  /** What ends a record, NUL under -z. */
  readonly terminator: string
  /** What an unsorted line does. */
  readonly order: OrderCheck
  /** --header. */
  readonly header: boolean
  /** The operand positions of FILE1 and FILE2. */
  readonly files: readonly [number, number]
}

function options(
  flags: Context['flags'],
  operands: readonly string[],
  argv: readonly string[],
): Record<string, JsonValue> {
  const tape = new FlagView(flags, specOf(CommandName.JOIN)).occurrences(
    OPERAND,
    SPELLED,
    ...OPTION_DESTS,
  )
  return {
    options: tape.map(([name, value]) => [
      name,
      typeof value === 'string' ? byteView(value) : value,
    ]),
    operands: operands.map((word) => byteView(word)),
    argv: argv.map((word) => byteView(word)),
  }
}

function parsed(stream: OpenStream): JoinFlags {
  const config = JSON.parse(new TextDecoder().decode(stream.metadata())) as {
    keys: [number, number]
    unpaired: [boolean, boolean]
    paired: boolean
    filler: number[] | null
    columns: [number, number][]
    auto_columns: boolean
    delimiter: number[] | null
    separator: number[]
    fold_case: boolean
    zero_terminated: boolean
    order: OrderCheck
    header: boolean
    files: [number, number]
  }
  return {
    keys: config.keys,
    unpaired: config.unpaired,
    paired: config.paired,
    filler: config.filler === null ? null : byteView(new Uint8Array(config.filler)),
    columns: config.columns,
    autoColumns: config.auto_columns,
    delimiter: config.delimiter === null ? null : byteView(new Uint8Array(config.delimiter)),
    separator: byteView(new Uint8Array(config.separator)),
    foldCase: config.fold_case,
    terminator: config.zero_terminated ? '\0' : '\n',
    order: config.order,
    header: config.header,
    files: config.files,
  }
}

export async function parseFlags(
  flags: Context['flags'],
  operands: readonly string[] = [],
  argv: readonly string[] = [],
): Promise<JoinFlags> {
  try {
    const engine = await openStream('join', options(flags, operands, argv))
    try {
      return parsed(engine)
    } finally {
      await closeStream(engine)
    }
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    throw new UsageError(error.message, 1)
  }
}

export interface JoinIO {
  read: (p: PathSpec) => AsyncIterable<Uint8Array>
  stdin: ByteSource | null
  flags: JoinFlags
  engine?: OpenStream
}

/**
 * GNU `join` of two files over already-parsed options: `paths` are the
 * operands, of which `flags.files` names the two files. Mirrors join in
 * join.py.
 */
export function join(paths: PathSpec[], io: JoinIO): [ByteSource | null, IOResult] {
  const p1 = paths[io.flags.files[0]]
  const p2 = paths[io.flags.files[1]]
  if (p1 === undefined || p2 === undefined) {
    throw missingOperandError(CommandName.JOIN, paths.at(-1)?.rawPath ?? null, [])
  }
  if (p1.rawPath === '-' && p2.rawPath === '-') {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode('join: both files cannot be standard input\n'),
      }),
    ]
  }
  const stream = stdinStream(io.read, io.stdin)
  const readers = [new AsyncLineIterator(stream(p1)), new AsyncLineIterator(stream(p2))] as const
  const result = new IOResult()
  const produced = joinStream(io.flags, readers, [p1, p2], result, io.engine)
  return [
    new OutputStream(produced, async () => {
      await produced.return(undefined)
      if (io.engine !== undefined) await closeStream(io.engine)
      for (const reader of readers) await reader.discard()
    }),
    result,
  ]
}

// join's line for an operand it cannot read: named as a missing one when it
// never opened, else as a read error.
function failure(reader: AsyncLineIterator, path: PathSpec, error: unknown): string {
  return neverOpened(reader, path, error)
    ? fsErrorLine(CommandName.JOIN, path, error)
    : `join: read error: ${fsStrerror(error) ?? String(error)}\n`
}

/**
 * Open both files before reading either, as GNU does: a missing FILE2 is
 * reported over a FILE1 that cannot be read (`join dir missing`). Stdin is
 * already open, so it is never read here: `join dir -` reports the directory
 * without waiting on input. Mirrors _open in join.py.
 */
async function openInputs(
  readers: readonly [AsyncLineIterator, AsyncLineIterator],
  paths: readonly [PathSpec, PathSpec],
): Promise<string> {
  let unreadable: [0 | 1, unknown] | null = null
  for (const side of [0, 1] as const) {
    if (isStdin(paths[side])) continue
    try {
      await readers[side].peek()
    } catch (error) {
      if (!isFsError(error)) throw error
      if (neverOpened(readers[side], paths[side], error)) {
        return failure(readers[side], paths[side], error)
      }
      unreadable ??= [side, error]
    }
  }
  if (unreadable === null) return ''
  const [side, error] = unreadable
  return failure(readers[side], paths[side], error)
}

/**
 * Walk the two inputs through the `join` engine; a failed read ends the run
 * after what join already printed. Mirrors _join_stream in join.py.
 */
async function* joinStream(
  flags: JoinFlags,
  readers: readonly [AsyncLineIterator, AsyncLineIterator],
  paths: readonly [PathSpec, PathSpec],
  io: IOResult,
  engine?: OpenStream,
): AsyncGenerator<Uint8Array> {
  const stream =
    engine ??
    (await openStream('join', {
      keys: [...flags.keys],
      unpaired: [...flags.unpaired],
      paired: flags.paired,
      filler: flags.filler,
      columns: flags.columns.map((item) => [...item]),
      auto_columns: flags.autoColumns,
      delimiter: flags.delimiter,
      separator: flags.separator,
      fold_case: flags.foldCase,
      zero_terminated: flags.terminator === '\0',
      order: flags.order,
      header: flags.header,
      names: paths.map((path) => byteView(path.rawPath)),
    }))
  let failed: 0 | 1 = 0
  const pull = (side: number): Promise<Uint8Array | null> => {
    failed = side === 0 ? 0 : 1
    return readers[failed].readChunk()
  }
  let error = ''
  try {
    try {
      error = await openInputs(readers, paths)
      if (error === '') yield* mergeOutput(stream, pull)
    } catch (caught) {
      if (!isFsError(caught)) throw caught
      error = failure(readers[failed], paths[failed], caught)
    }
  } finally {
    io.stderr = concat([stream.takeStderr(), encodeText(error)])
    io.exitCode = error === '' ? stream.status() : 1
    await closeStream(stream)
    for (const reader of readers) await reader.discard()
  }
}

/**
 * The builder's entry point: parse the line's flags, then `join`. Each operand's
 * glob expands on its own, so the option loop sees its matches where the
 * word was typed (`join -j1 2 *.txt`). Mirrors join_generic in join.py.
 */
export async function joinGeneric(
  paths: PathSpec[],
  ctx: Context,
  resolveGlob: (targets: PathSpec[]) => Promise<PathSpec[]>,
  read: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const groups: PathSpec[][] = []
  for (const path of paths) groups.push(await resolveGlob([path]))
  const resolved = groups.flat()
  const flags = spreadOperands(
    ctx.flags,
    groups.map((group) => group.map((path) => path.rawPath)),
  )
  try {
    const engine = await openStream(
      'join',
      options(
        flags,
        resolved.map((path) => path.rawPath),
        ctx.argv ?? [],
      ),
    )
    try {
      const result = join(resolved, { read, stdin: ctx.stdin, flags: parsed(engine), engine })
      if (result[0] === null) await closeStream(engine)
      return result
    } catch (error) {
      await closeStream(engine)
      throw error
    }
  } catch (error) {
    if (!(error instanceof StreamRefusal)) throw error
    throw new UsageError(error.message, 1)
  }
}
