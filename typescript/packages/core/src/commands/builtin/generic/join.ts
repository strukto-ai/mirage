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

import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { specOf } from '../../spec/builtins.ts'
import { LAST_WORD, OPERAND, SPELLED } from '../../spec/constants.ts'
import { FlagView, spreadOperands } from '../../spec/flag_view.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { JsonValue, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { CommandName } from '../../spec/types.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { StreamRefusal } from '../../../rs/errors.ts'
import { refused, scan } from '../../../rs/scan.ts'
import { closeStream, mergeOutput, openStream } from '../../../rs/stream.ts'
import { concat } from '../../../utils/bytes.ts'
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

/** join's line as mirage-rs read it. Mirrors JoinFlags in join.py. */
export interface JoinFlags {
  /** The `join` engine's config. */
  readonly engine: Record<string, JsonValue>
  /** The operand positions of FILE1 and FILE2. */
  readonly files: readonly [number, number]
}

/**
 * Read join's options and operands in the order the line typed them.
 * mirage-rs reads the tape in one pass, as GNU join's getopt loop does, so
 * the first problem left to right is the one reported. `operands` are the
 * operands in order, a glob's matches in its place; when the tape places
 * none, they are read after every option and a `--`, so each is a file.
 * `argv` is the line's words after `join`, which the missing-operand line
 * names the last of. The engine's config and the two files, or join's
 * refusal; throws when the tape places other operands than `operands`.
 * Mirrors parse_flags in join.py.
 */
export function parseFlags(
  flags: Context['flags'],
  operands: readonly string[] = [],
  argv: readonly string[] = [],
): JoinFlags | IOResult {
  const typed = new FlagView(flags, specOf(CommandName.JOIN)).texts(
    OPERAND,
    SPELLED,
    ...OPTION_DESTS,
  )
  const placed = typed.filter(([name]) => name === OPERAND).length
  if (placed === 0 && operands.length > 0) {
    typed.push([SPELLED, '--'], ...operands.map((word): [string, string] => [OPERAND, word]))
  } else if (placed !== operands.length) {
    throw new Error(
      `join's tape places ${String(placed)} operands, not its ${String(operands.length)}`,
    )
  }
  const last = argv.at(-1)
  if (last !== undefined) typed.push([LAST_WORD, last])
  let values: Record<string, JsonValue>
  try {
    values = scan('join', typed)
  } catch (err) {
    if (!(err instanceof StreamRefusal)) throw err
    return refused(err)
  }
  const { engine, files } = values
  if (
    typeof engine === 'object' &&
    engine !== null &&
    !Array.isArray(engine) &&
    Array.isArray(files) &&
    typeof files[0] === 'number' &&
    typeof files[1] === 'number'
  ) {
    return { engine, files: [files[0], files[1]] }
  }
  throw new Error(`join's scan read no engine and files: ${JSON.stringify(values)}`)
}

export interface JoinIO {
  read: (p: PathSpec) => AsyncIterable<Uint8Array>
  stdin: ByteSource | null
  flags: JoinFlags
}

/**
 * GNU `join` of two files over already-parsed options: `paths` are the
 * operands, of which `flags.files` names the two files. Mirrors join in
 * join.py.
 */
export function join(paths: PathSpec[], io: JoinIO): [ByteSource | null, IOResult] {
  const [p1, p2] = io.flags.files.map((index) => paths[index])
  if (p1 === undefined || p2 === undefined) {
    throw new Error(`join's files ${String(io.flags.files)} are not among its operands`)
  }
  const stream = stdinStream(io.read, io.stdin)
  const readers = [new AsyncLineIterator(stream(p1)), new AsyncLineIterator(stream(p2))] as const
  const result = new IOResult()
  return [joinStream(io.flags, readers, [p1, p2], result), result]
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
): AsyncIterable<Uint8Array> {
  const stream = await openStream('join', flags.engine)
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
  const parsed = parseFlags(
    flags,
    resolved.map((path) => path.rawPath),
    ctx.argv ?? [],
  )
  if (parsed instanceof IOResult) return [null, parsed]
  return join(resolved, { read, stdin: ctx.stdin, flags: parsed })
}
