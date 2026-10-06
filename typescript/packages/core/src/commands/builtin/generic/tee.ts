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
import type { PathSpec, StatFn } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { eisdir, enoent, enotdir, isEnoent, isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { type FsError } from '../../../errors/types.ts'
import { absentDestStrerror, entryKind } from '../utils/paths.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { type FlagValue } from '../../spec/types.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { posixPhrase } from '../../../errors/posix.ts'

export interface TeeFlags {
  append: boolean
  stopOnError: boolean
}

export function parseFlags(bag: Record<string, FlagValue>): TeeFlags {
  // --output-error values are validated declaratively: the spec's
  // choices= makes the parser report any other value and the executor
  // refuse with GNU's ARGMATCH shape before tee runs. Only the exit/warn
  // axis is observable here: the -nopipe half distinguishes a pipe sink
  // from a file sink, and every operand tee writes is a file. A bare
  // --output-error means warn (GNU 9.7).
  const fl = new FlagView(bag, specOf('tee'))
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
  stat?: StatFn,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  const stdinData = await readStdinAsync(opts.stdin)
  const raw: Uint8Array = stdinData ?? encodeText(texts.join(' '))
  if (paths.length === 0) return [raw, new IOResult()]
  return writeOutput(paths, raw, parsed, stream, write, append, stat)
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
  parsed: TeeFlags,
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
// GNU's diagnostic for one unwritable operand. Mirrors Python's error_line.
function errorLine(path: PathSpec, err: unknown): string {
  if (isFsError(err)) return fsErrorLine('tee', path, err)
  return `tee: ${path.mountPath}: ${err instanceof Error ? err.message : String(err)}\n`
}

// The error GNU's open of an output would meet, or null. GNU opens the
// outputs in order, so each earlier one is a regular file by now: an output
// under one of them is `Not a directory`. Mirrors Python's open_refusal.
export async function openRefusal(
  stat: StatFn,
  path: PathSpec,
  opened: readonly PathSpec[],
): Promise<FsError | null> {
  if (opened.some((o) => path.virtual.startsWith(`${rstripSlash(o.virtual)}/`))) {
    return enotdir(path)
  }
  const { exists, isDir } = await entryKind(stat, path)
  if (isDir) return eisdir(path)
  if (exists) return null
  const strerror = await absentDestStrerror(stat, path)
  if (strerror === null) return null
  return strerror === posixPhrase('ENOTDIR') ? enotdir(path) : enoent(path)
}

export async function writeOutput(
  paths: PathSpec[],
  raw: Uint8Array,
  parsed: TeeFlags,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  append?: (p: PathSpec, data: Uint8Array) => Promise<void>,
  stat?: StatFn,
): Promise<[ByteSource | null, IOResult]> {
  const writes: Record<string, ByteSource> = {}
  const cache: string[] = []
  const errors: string[] = []
  // GNU opens every output before it reads a byte: under exit the first open
  // failure ends the run with nothing written, the outputs before it made
  // empty. A mount write is one call, so the open is probed first. A probe
  // the backend will not answer (a stat its credentials refuse) is no
  // verdict, so that output is opened for real, by writing it nothing, once
  // the outputs before it are opened. Opening an earlier output can fail
  // first, and then it is the one reported.
  if (parsed.stopOnError && stat !== undefined) {
    const opened = new Set<string>()
    for (const [index, path] of paths.entries()) {
      let probed = true
      let refusal: unknown = null
      try {
        refusal = await openRefusal(stat, path, paths.slice(0, index))
      } catch (err) {
        console.warn(`tee: probing ${path.virtual} failed: ${String(err)}`)
        probed = false
      }
      if (probed && refusal === null) continue
      let failed = path
      for (const prior of paths.slice(0, index)) {
        if (opened.has(prior.mountPath)) continue
        try {
          if (!(parsed.append && (await entryKind(stat, prior)).exists)) {
            await write(prior, new Uint8Array(0))
            writes[prior.mountPath] = new Uint8Array(0)
            cache.push(prior.mountPath)
          }
        } catch (err) {
          failed = prior
          refusal = err
          break
        }
        opened.add(prior.mountPath)
      }
      if (refusal === null) {
        try {
          const data = await writeOne(path, new Uint8Array(0), parsed, stream, write, append)
          writes[path.mountPath] = data ?? new Uint8Array(0)
          opened.add(path.mountPath)
          continue
        } catch (err) {
          refusal = err
        }
      }
      const stderr = encodeText(errorLine(failed, refusal))
      return [null, new IOResult({ exitCode: 1, stderr, writes, cache })]
    }
  }
  for (const [index, path] of paths.entries()) {
    // A store keeps a key over a directory or under a file, where an open
    // would fail, so the open is probed for every output, not only the ones
    // --output-error=exit probed above. A missing parent is the write's to
    // refuse, which a keyed store makes as a redirect does.
    let refusal: FsError | null = null
    if (stat !== undefined && !parsed.stopOnError) {
      try {
        refusal = await openRefusal(stat, path, paths.slice(0, index))
      } catch (err) {
        console.warn(`tee: probing ${path.virtual} failed: ${String(err)}`)
      }
    }
    if (refusal !== null && refusal.code !== 'ENOENT') {
      errors.push(errorLine(path, refusal))
      continue
    }
    let data: Uint8Array | null
    try {
      data = await writeOne(path, raw, parsed, stream, write, append)
    } catch (err) {
      errors.push(errorLine(path, err))
      if (parsed.stopOnError) break
      continue
    }
    writes[path.mountPath] = data ?? raw
    if (data !== null && !cache.includes(path.mountPath)) cache.push(path.mountPath)
  }
  if (errors.length > 0) {
    return [raw, new IOResult({ exitCode: 1, stderr: encodeText(errors.join('')), writes, cache })]
  }
  return [raw, new IOResult({ writes, cache })]
}
