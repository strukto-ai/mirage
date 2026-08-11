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
import { fsErrorLine, isEnoent, isFsError } from '../../../utils/errors.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView, type FlagValue } from '../../spec/types.ts'

const ENC = new TextEncoder()

export interface TeeOptions {
  append: boolean
  stopOnError: boolean
}

export function parseTeeFlags(flags: Record<string, FlagValue>): TeeOptions {
  // --output-error values are validated declaratively: the spec's
  // choices= makes the parser report any other value and the executor
  // refuse with GNU's ARGMATCH shape before tee runs. Only the exit/warn
  // axis is observable here: the -nopipe half distinguishes a pipe sink
  // from a file sink, and every operand tee writes is a file. A bare
  // --output-error means warn (GNU 9.7).
  const fl = new FlagView(flags, specOf('tee'))
  const mode = fl.asStr('output_error')
  return {
    append: fl.asBool('append'),
    stopOnError: mode === 'exit' || mode === 'exit-nopipe',
  }
}

export async function teeGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  append?: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  if (paths.length === 0) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('tee: missing operand\n') })]
  }
  const parsed = parseTeeFlags(opts.flags)
  const stdinData = await readStdinAsync(opts.stdin)
  const raw: Uint8Array = stdinData ?? ENC.encode(texts.join(' '))
  return writeOutput(paths, raw, parsed, stream, write, append)
}

/**
 * Write one operand, returning its new content when that is known.
 *
 * `null` means "written, but the resulting bytes are not in hand" — the native
 * append case. The caller then lists the path in `writes` without listing it in
 * `cache`, which is how the cache layer is told to drop the stale entry instead
 * of caching a wrong one. That costs one read on the next access and saves
 * reading and re-uploading the whole object on this one.
 */
async function writeOne(
  path: PathSpec,
  raw: Uint8Array,
  parsed: TeeOptions,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  append: ((p: PathSpec, data: Uint8Array) => Promise<void>) | undefined,
): Promise<Uint8Array | null> {
  if (!parsed.append) {
    await write(path, raw)
    return raw
  }
  if (append !== undefined) {
    await append(path, raw)
    return null
  }
  let existing: Uint8Array = new Uint8Array(0)
  try {
    existing = await materialize(stream(path))
  } catch (err) {
    // GNU tee -a creates a missing file: append to empty. This used to test
    // the message for /not found/i, which never matched — `enoent()` puts the
    // *path* in the message — so `tee -a missing` threw on every backend, and
    // s3/gridfs grew bespoke wrappers with an exists() pre-check to dodge it.
    if (!isEnoent(err)) throw err
  }
  const data = new Uint8Array(existing.byteLength + raw.byteLength)
  data.set(existing, 0)
  data.set(raw, existing.byteLength)
  await write(path, data)
  return data
}

/**
 * Copy `raw` to every operand, GNU-style.
 *
 * An operand that cannot be written is diagnosed and skipped rather than ending
 * the run: GNU keeps going and still writes the rest, and only
 * `--output-error=exit` stops at the first failure. stdin always reaches stdout
 * either way. The operand is named as typed and the strerror comes from the
 * shared table, so an unwritable destination reads like GNU rather than
 * exposing the backend's own exception text.
 *
 * Deliberate divergence: GNU opens every operand up front, so under `exit` an
 * *open* failure aborts before any data is written. A mount has no open/write
 * split — `write` is one call — so the operands before the failure are already
 * written. The two agree whenever the failure is at write time, which is what a
 * remote backend reports.
 */
export async function writeOutput(
  paths: PathSpec[],
  raw: Uint8Array,
  parsed: TeeOptions,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  append?: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<[ByteSource | null, IOResult]> {
  const writes: Record<string, ByteSource> = {}
  const cache: string[] = []
  const errors: string[] = []
  for (const path of paths) {
    let data: Uint8Array | null
    try {
      data = await writeOne(path, raw, parsed, stream, write, append)
    } catch (err) {
      errors.push(
        isFsError(err)
          ? fsErrorLine('tee', path, err)
          : `tee: ${path.mountPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      if (parsed.stopOnError) break
      continue
    }
    writes[path.mountPath] = data ?? raw
    if (data !== null) cache.push(path.mountPath)
  }
  if (errors.length > 0) {
    return [raw, new IOResult({ exitCode: 1, stderr: ENC.encode(errors.join('')), writes, cache })]
  }
  return [raw, new IOResult({ writes, cache })]
}
