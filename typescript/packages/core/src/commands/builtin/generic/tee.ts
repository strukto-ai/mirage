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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { fsErrorLine, isFsError } from '../../../utils/errors.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView, type FlagValue } from '../../spec/types.ts'

const ENC = new TextEncoder()

export interface TeeOptions {
  append: boolean
}

export function parseTeeFlags(flags: Record<string, FlagValue>): TeeOptions {
  // --output-error values are validated declaratively: the spec's
  // choices= makes the parser report any other value and the executor
  // refuse with GNU's ARGMATCH shape before tee runs.
  const fl = new FlagView(flags, specOf('tee'))
  return { append: fl.asBool('append') }
}

export async function teeGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tee: missing operand\n') })]
  }
  const parsed = parseTeeFlags(opts.flags)
  const first = paths[0]
  if (first === undefined) return [null, new IOResult()]
  const stdinData = await readStdinAsync(opts.stdin)
  const raw: Uint8Array = stdinData ?? ENC.encode(texts.join(' '))
  let writeData = raw
  if (parsed.append) {
    try {
      const existing = await materialize(stream(first))
      writeData = new Uint8Array(existing.byteLength + raw.byteLength)
      writeData.set(existing, 0)
      writeData.set(raw, existing.byteLength)
    } catch (err) {
      if (!(err instanceof Error) || !/not found/i.test(err.message)) throw err
    }
  }
  return writeOutput(write, first, writeData, raw)
}

export async function writeOutput(
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  path: PathSpec,
  data: Uint8Array,
  passthrough: ByteSource,
): Promise<[ByteSource | null, IOResult]> {
  try {
    await write(path, data)
  } catch (err) {
    // GNU tee still copies stdin to stdout on a write error, prints a
    // diagnostic, and exits non-zero. With a single output sink the
    // --output-error modes (warn/exit/*-nopipe) collapse to this. The
    // operand is named as typed and the strerror comes from the shared
    // table, so an unwritable destination reads like GNU rather than
    // exposing the backend's own exception text.
    const line = isFsError(err)
      ? fsErrorLine('tee', path, err)
      : `tee: ${path.mountPath}: ${err instanceof Error ? err.message : String(err)}\n`
    return [passthrough, new IOResult({ exitCode: 1, stderr: ENC.encode(line) })]
  }
  return [
    passthrough,
    new IOResult({ writes: { [path.mountPath]: data }, cache: [path.mountPath] }),
  ]
}
