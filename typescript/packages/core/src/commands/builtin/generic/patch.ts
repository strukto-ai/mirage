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

import type { util } from 'zod'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { ByteSpool } from '../../../io/spool.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { classify, failureText } from '../../../errors/classify.ts'
import { fsStrerror, isEisdir, isEnoent, isFsError } from '../../../errors/fs.ts'
import { shellQuote } from '../../../utils/quote.ts'
import { openStream, serveRequests, type Served } from '../../../rs/stream.ts'
import { byteView, textView } from '../../../shell/bytes.ts'
import { linksOf, mountRoot, nameLocation } from '../utils/links.ts'
import { CycleError, resolvePath } from '../../../utils/path.ts'
import type { LinkView } from '../../../view/types.ts'
import { UINTMAX } from '../constants.ts'

function companion(spec: PathSpec, suffix: string): PathSpec {
  return PathSpec.fromStrPath(spec.virtual + suffix, spec.vfsPath + suffix)
}

/**
 * The patch text, or GNU's fatal line when it cannot be had. GNU opens the
 * patch file before anything else and gives up on the whole run when it
 * cannot (exit 2): an open that fails names the file (`Can't open patch file
 * x : ...`), a read that fails does not (`read error : ...`), since only one
 * patch file is ever read. Mirrors Python's _load_patch_data.
 */
async function loadPatchData(
  source: PathSpec | null,
  stdin: ByteSource | null,
  read: (p: PathSpec) => Promise<Uint8Array>,
): Promise<Uint8Array | string> {
  if (source === null) return (await readStdinAsync(stdin)) ?? new Uint8Array()
  try {
    return await read(source)
  } catch (err) {
    if (!isFsError(err)) throw err
    const code = (err as { code?: string }).code
    if (code !== undefined && READ_FAILURES.has(code)) {
      return `patch: **** read error : ${String(fsStrerror(err))}\n`
    }
    return `patch: **** Can't open patch file ${shellQuote(source.rawPath)} : ${String(fsStrerror(err))}\n`
  }
}

/** What patch changes on a path besides writing it. */
type PatchChanges = Readonly<Record<'mkdir' | 'unlink' | 'rmdir', (p: PathSpec) => Promise<void>>>

/**
 * The files mirage-rs's patch engine reads and writes, whole. The engine
 * reads the patch as `-` and names every other file as its report does: the
 * ORIGFILE operand as typed, or a name from the patch, which resolves against
 * the working directory, as GNU's does; `.orig` and `.rej` after either name
 * its companions. It stats the names it picks the file among, makes the
 * directories a file it creates needs, and removes a file it empties with
 * the directories that leaves empty. A file that is not there, is a directory
 * or is a link is the engine's to report; any other failure is the command's.
 * Mirrors Python's _PatchFiles.
 */
class PatchFiles {
  readonly errors = new ByteSpool()

  constructor(
    private readonly source: PathSpec | null,
    private readonly stdin: ByteSource | null,
    private readonly orig: PathSpec | null,
    private readonly cwd: string,
    private readonly root: string,
    private readonly read: (p: PathSpec) => Promise<Uint8Array>,
    private readonly write: (p: PathSpec, data: Uint8Array) => Promise<void>,
    private readonly stat: (p: PathSpec) => Promise<FileStat>,
    private readonly links: LinkView | undefined,
    private readonly changes: PatchChanges,
  ) {}

  /**
   * The file a name the engine gives stands for. A stat or a read keeps the
   * name as spelled, so `f/` or `f/.` asks for a directory, as GNU's stat
   * does; a change drops the `.` steps a store without empty directories
   * cannot walk, unless the name ends naming a directory, and keeps each
   * `..` for the walk to take after the links before it, as the system's
   * own lookup does. Mirrors Python's `_spec`.
   */
  private spec(path: string, change = false): PathSpec {
    if (this.orig !== null) {
      const typed = byteView(this.orig.rawPath)
      if (path.startsWith(typed)) {
        const suffix = textView(path.slice(typed.length))
        if (suffix === '') return this.orig
        const where = this.linked(this.orig)
        if (where === null) return companion(this.orig, suffix)
        return PathSpec.fromStrPath(where + suffix, mountKey(where + suffix, this.root))
      }
    }
    let name = textView(path)
    const key = mountKey(resolvePath(name, this.cwd), this.root)
    if (change && !name.endsWith('/') && !name.endsWith('/.') && name !== '.') {
      const parts = name.split('/').filter((part) => part !== '' && part !== '.')
      name = (name.startsWith('/') ? '/' : '') + parts.join('/')
    }
    return PathSpec.fromStrPath(name, key, this.cwd)
  }

  /**
   * Where the link a name ends in stands, null when it ends in none. Mirrors
   * Python's `_linked`.
   */
  private linked(spec: PathSpec): string | null {
    if (this.links === undefined) return null
    let where: string | null
    try {
      where = nameLocation(this.links, spec, this.cwd)
    } catch (err) {
      if (err instanceof CycleError) return null
      throw err
    }
    return where !== null && this.links.statAt(where) !== null ? where : null
  }

  private async kind(path: string): Promise<Record<string, util.JSONType>> {
    let found: FileStat
    try {
      let spec = this.spec(path)
      const real = this.links?.resolve(spec.virtual) ?? spec.virtual
      if (real !== spec.virtual) spec = PathSpec.fromStrPath(real, mountKey(real, this.root))
      found = await this.stat(spec)
    } catch (err) {
      if (isEisdir(err)) return { kind: 'dir' }
      if (err instanceof CycleError || isEnoent(err) || classify(err) === 'ENOTDIR') {
        return this.linked(this.spec(path)) === null ? {} : { kind: 'link' }
      }
      throw err
    }
    return { kind: found.type === FileType.DIRECTORY ? 'dir' : 'file' }
  }

  private async change(
    op: keyof PatchChanges,
    path: string,
  ): Promise<Record<string, util.JSONType>> {
    try {
      await this.changes[op](this.spec(path, true))
    } catch (err) {
      if (!isFsError(err)) throw err
      const errno = classify(err)
      const error = byteView(failureText(err))
      return errno === null ? { error } : { error, errno }
    }
    return {}
  }

  async serve(request: Readonly<Record<string, util.JSONType>>, data: Uint8Array): Promise<Served> {
    const path = typeof request.path === 'string' ? request.path : ''
    if (request.op === 'write') {
      await this.write(this.spec(path, true), data)
      return { reply: {} }
    }
    if (request.op === 'stat') return { reply: await this.kind(path) }
    if (request.op === 'mkdir' || request.op === 'unlink' || request.op === 'rmdir') {
      return { reply: await this.change(request.op, path) }
    }
    if (request.file !== true) {
      const patch = await loadPatchData(this.source, this.stdin, this.read)
      if (typeof patch === 'string') return { reply: { line: byteView(patch) } }
      return { reply: { end: true }, data: patch }
    }
    const spec = this.spec(path)
    try {
      if (this.linked(spec) !== null) return { reply: { errno: 'ELOOP' } }
      return { reply: { end: true }, data: await this.read(spec) }
    } catch (err) {
      if (isEisdir(err)) return { reply: { errno: 'EISDIR' } }
      if (isEnoent(err) || classify(err) === 'ENOTDIR') return { reply: { errno: 'ENOENT' } }
      throw err
    }
  }
}

// A -p value is one optional sign, then digits to the end of the word:
// GNU patch 2.8 refuses `3x` and ` 1`, and takes `+0`.
const STRIP_COUNT = /^[+-]?[0-9]+$/

// `-p` as GNU patch scans it, null for no number. Mirrors Python's
// `_strip_count`.
function stripCount(text: string): bigint | null {
  return STRIP_COUNT.test(text) ? BigInt(text) : null
}

// GNU patch's fatal line for a -p value that is no number or negative.
// Mirrors Python's `_strip_refusal`.
function stripRefusal(text: string, value: bigint | null): string {
  const problem = value === null ? 'is not a number' : 'is negative'
  return `patch: **** strip count ${shellQuote(text)} ${problem}`
}

interface PatchFlags {
  readonly strip: number | null
  readonly reverse: boolean
  // -i as the parser classified it: a path keeps its typed spelling.
  readonly inputPath: PathSpec | string | null
  readonly forward: boolean
}

function parseFlags(bag: Record<string, FlagValue>): PatchFlags {
  const fl = new FlagView(bag, specOf('patch'))
  const input = fl.raw('i')
  const strip = fl.asNumber('p', stripCount, stripRefusal, { low: 0n, exitCode: 2 }) ?? null
  // A count past a name's slashes strips them all, as any larger one does,
  // so UINTMAX stands in for one JSON cannot carry to mirage-rs.
  return {
    strip: strip === null ? null : Number(strip > UINTMAX ? UINTMAX : strip),
    reverse: fl.asBool('R'),
    inputPath: input instanceof PathSpec ? input : (fl.asStr('i') ?? null),
    forward: fl.asBool('N'),
  }
}

export async function patchGeneric(
  paths: PathSpec[],
  ctx: Context,
  read: (p: PathSpec) => Promise<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  stat: (p: PathSpec) => Promise<FileStat>,
  changes: PatchChanges,
): Promise<CommandFnResult> {
  const parsed = parseFlags(ctx.flags)
  if (paths.length > 2) throw extraOperandError(CommandName.PATCH, paths[2]?.rawPath ?? '')
  const root = mountRoot(ctx)
  // `patch [ORIGFILE [PATCHFILE]]`: the second operand is the patch file,
  // ahead of -i, and the first is the one file every hunk goes to in place
  // of the names the patch's headers carry, which otherwise resolve against
  // the working directory. A `-i` classified as a path keeps its typed
  // spelling, which the fatal line names. Mirrors Python's patch_generic.
  const input = parsed.inputPath
  const source =
    paths[1] ??
    (input instanceof PathSpec
      ? input
      : input !== null
        ? PathSpec.fromStrPath(input, mountKey(input, root))
        : null)
  const orig = paths[0] ?? null
  const files = new PatchFiles(
    source,
    ctx.stdin,
    orig,
    ctx.cwd.virtual,
    root,
    read,
    write,
    stat,
    linksOf(ctx),
    changes,
  )
  const engine = await openStream('patch', {
    strip: parsed.strip,
    reverse: parsed.reverse,
    forward: parsed.forward,
    file: orig === null ? null : byteView(orig.rawPath),
  })
  try {
    const output = await materialize(serveRequests(engine, files))
    const stderr = await files.errors.output()
    return [
      output.byteLength > 0 ? output : null,
      new IOResult({ exitCode: engine.status(), stderr }),
    ]
  } finally {
    engine.close()
  }
}
