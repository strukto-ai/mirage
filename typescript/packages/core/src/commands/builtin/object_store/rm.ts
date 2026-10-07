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

import type { Accessor } from '../../../accessor/base.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, type PathSpec } from '../../../types.ts'
import { fsStrerror, isFsError } from '../../../errors/fs.ts'
import { command, type CommandFnResult, type CommandOpts, type CommandFn } from '../../config.ts'
import type { RegisteredCommand } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { cpWalk } from '../generic/cp.ts'
import { rmWithoutOperands } from '../generic/rm_cmd.ts'
import { requireOp, overMountIo } from '../generic_bind/adapter.ts'
import { resolveGlobOf, type CommandIO } from '../generic_bind/index.ts'
import { formatRecords } from '../utils/output.ts'
import { isSlashedLink, rmLinkRefusal } from '../utils/slash_links.ts'
import { removalLines } from '../utils/verbose.ts'

const ENC = new TextEncoder()

interface RmOpts {
  recursive: boolean
  force: boolean
  removeDir: boolean
  verbose: boolean
}

/** Build the no-real-directories rm override for one keyed store. */
function build<A extends Accessor>(io: CommandIO<A>): CommandFn<A> {
  const stat = io.stat
  const readdir = io.readdir
  const resolveGlob = resolveGlobOf(io)
  const unlink = requireOp(io.unlink, 'unlink')
  const rmdir = requireOp(io.rmdir, 'rmdir')
  const rmR = requireOp(io.rmR, 'rmR')

  // Remove one operand, returning a GNU stderr line on failure (null when
  // removed, or skipped under -f) alongside the verbose lines.
  async function rmOne(
    accessor: A,
    path: PathSpec,
    opts: RmOpts,
    index: CommandOpts['index'],
  ): Promise<[string | null, string[]]> {
    const label = path.rawPath
    let isDir = false
    try {
      const st = await stat(accessor, path, index ?? undefined)
      isDir = st.type === FileType.DIRECTORY
    } catch (err) {
      if (!isFsError(err)) throw err
      const code = (err as { code?: string }).code
      if (opts.force && (code === 'ENOENT' || code === 'ENOTDIR')) return [null, []]
      return [`rm: cannot remove '${label}': ${String(fsStrerror(err))}`, []]
    }
    try {
      if (isDir) {
        if (opts.recursive) {
          const lines = opts.verbose
            ? removalLines(
                await cpWalk(
                  (dir) => readdir(accessor, dir, index ?? undefined),
                  (spec) => stat(accessor, spec, index ?? undefined),
                  path,
                  index ?? undefined,
                ),
                path,
              )
            : []
          await rmR(accessor, path)
          return [null, lines]
        }
        if (opts.removeDir) {
          const children = await readdir(accessor, path, index ?? undefined)
          if (children.length > 0) {
            return [`rm: cannot remove '${label}': Directory not empty`, []]
          }
          await rmdir(accessor, path)
          return [null, opts.verbose ? [`removed directory '${label}'`] : []]
        }
        return [`rm: cannot remove '${label}': Is a directory`, []]
      }
      await unlink(accessor, path)
    } catch (err) {
      // A refused removal (a read-only region) is GNU's line for the
      // operand, and rm goes on to the rest.
      if (!isFsError(err)) throw err
      return [`rm: cannot remove '${label}': ${String(fsStrerror(err))}`, []]
    }
    return [null, opts.verbose ? [`removed '${label}'`] : []]
  }

  async function rmCommand(
    accessor: A,
    paths: PathSpec[],
    _texts: string[],
    opts: CommandOpts,
  ): Promise<CommandFnResult> {
    const fl = new FlagView(opts.flags, specOf('rm'))
    const recursive = fl.asBool('r') || fl.asBool('R')
    const force = fl.asBool('f')
    const removeDir = fl.asBool('d')
    const verbose = fl.asBool('v')
    if (paths.length === 0) return rmWithoutOperands(force)
    const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
    const verboseParts: string[] = []
    const errors: string[] = []
    const writes: Record<string, Uint8Array> = {}
    const links = opts.ns?.links ?? null
    for (const p of resolved) {
      // A link typed with a trailing slash is refused, never followed: the
      // shared helper keeps this identical to the generic builder.
      if (isSlashedLink(p, links)) {
        const refusal = await rmLinkRefusal(p, links, { recursive, force })
        if (refusal !== null) errors.push(refusal)
        continue
      }
      // GNU rm reports the operand and keeps removing the rest.
      const [error, entryLines] = await rmOne(
        accessor,
        p,
        { recursive, force, removeDir, verbose },
        opts.index,
      )
      if (error !== null) {
        errors.push(error)
        continue
      }
      writes[p.mountPath] = new Uint8Array()
      if (verbose) verboseParts.push(...entryLines)
    }
    const output: ByteSource | null = verbose ? formatRecords(verboseParts) : null
    const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : undefined
    return [
      output,
      new IOResult({
        writes,
        exitCode: errors.length > 0 ? 1 : 0,
        ...(stderr !== undefined ? { stderr } : {}),
      }),
    ]
  }

  return rmCommand
}

/** The keyed-store `rm` over the running mount's table, guarded by `wrap`. */
export function makeRm(vfs: string, wrap: (io: CommandIO) => CommandIO): RegisteredCommand[] {
  return command({
    name: 'rm',
    vfs,
    spec: specOf('rm'),
    fn: overMountIo(build, wrap),
    write: true,
    pathGuarded: true,
  })
}
