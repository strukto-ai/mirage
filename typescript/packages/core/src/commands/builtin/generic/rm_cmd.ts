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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import { FileType, type FileStat, type PathSpec, type VFSName } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { fsStrerror, isEnoent, isFsError } from '../../../errors/fs.ts'
import { command, type CommandFnResult, type CommandOpts, type Command } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { mountIo, requireOp, resolveGlobOf } from '../generic_bind/adapter.ts'
import { formatRecords } from '../utils/output.ts'
import { descendantPath } from '../utils/paths.ts'
import { pathVisible } from '../../../utils/hidden.ts'
import type { NamespaceView } from '../../../view/types.ts'

const ENC = new TextEncoder()

// rm's answer to a line with no operand, in GNU's words: nothing at all under
// -f, and a missing-operand usage error otherwise (coreutils 9.7). Mirrors
// Python's rm_without_operands.
export function rmWithoutOperands(force: boolean): CommandFnResult {
  if (force) return [null, new IOResult()]
  throw new UsageError("rm: missing operand\nTry 'rm --help' for more information.", 1)
}

/**
 * Remove a directory tree entry by entry, as GNU `rm -r` does.
 *
 * For a tree whose one-call removal the dispatcher declined, so each removal
 * is judged on its own. An entry that cannot be removed, or a directory that
 * cannot be opened, is a failure, and the directories above it stay without a
 * line of their own, since they are not empty (coreutils 9.7). The links a
 * directory holds go with it; a hidden one is left to the directory's own
 * removal, which takes what the session cannot see. A mount below is never
 * entered, as GNU's `--one-file-system` does, and the directories holding one
 * stay. Under `-f` an entry gone before its removal is no failure. Mirrors
 * Python's `remove_tree`.
 */
export async function removeTree(
  root: PathSpec,
  ops: {
    readdir: (path: PathSpec) => Promise<string[]>
    stat: (path: PathSpec) => Promise<FileStat>
    unlink: (path: PathSpec) => Promise<void>
    rmdir: (path: PathSpec) => Promise<void>
    ns: NamespaceView | null | undefined
    force: boolean
  },
): Promise<{ removed: { path: string; isDir: boolean }[]; failures: [PathSpec, unknown][] }> {
  const links = ops.ns?.links
  const vis = ops.ns?.visibility
  const roots = new Set(ops.ns?.mounts?.descendants(root.virtual) ?? [])
  const removed: { path: string; isDir: boolean }[] = []
  const failures: [PathSpec, unknown][] = []
  const remove = async (path: PathSpec, isDir: boolean): Promise<boolean> => {
    let names: string[]
    try {
      if (!isDir) {
        await ops.unlink(path)
        removed.push({ path: path.virtual, isDir: false })
        return true
      }
      names = await ops.readdir(path)
    } catch (err) {
      if (!isFsError(err)) throw err
      if (ops.force && isEnoent(err)) return true
      failures.push([path, err])
      return false
    }
    const base = path.virtual.replace(/\/+$/, '')
    let cleared = true
    for (const name of names) {
      const child = descendantPath(root, name.replace(/\/+$/, ''))
      if (roots.has(child.virtual)) continue
      if (links?.statAt(child.virtual) != null) continue
      let info: FileStat
      try {
        info = await ops.stat(child)
      } catch (err) {
        if (!isFsError(err)) throw err
        if ((err as { code?: string }).code === 'ENOENT') continue
        failures.push([child, err])
        cleared = false
        continue
      }
      const gone = await remove(child, info.type === FileType.DIRECTORY)
      cleared = cleared && gone
    }
    for (const row of links?.children(base) ?? []) {
      const link = descendantPath(root, `${base}/${row.name}`)
      if (!pathVisible(vis, link.virtual)) continue
      const gone = await remove(link, false)
      cleared = cleared && gone
    }
    if (!cleared || [...roots].some((r) => r.startsWith(`${base}/`))) return false
    try {
      await ops.rmdir(path)
    } catch (err) {
      if (!isFsError(err)) throw err
      if (ops.force && isEnoent(err)) return true
      failures.push([path, err])
      return false
    }
    removed.push({ path: path.virtual, isDir: true })
    return true
  }
  await remove(root, true)
  return { removed, failures }
}

/**
 * Build a file-only `rm` over the mount's `unlink`, resolving globs through
 * the mount's table.
 *
 * Every API-backed mount spells the same GNU behaviour: report the operand
 * it could not remove, keep removing the rest, and exit 1 if any failed.
 * The unlink goes through the dispatcher, which judges each path and settles
 * the removal. Mirrors Python's `make_rm`.
 */
export function makeRm(vfs: VFSName): Command[] {
  return command({
    name: 'rm',
    vfs,
    spec: specOf('rm'),
    write: true,
    pathGuarded: true,
    fn: async (
      accessor: Accessor,
      paths: PathSpec[],
      _texts: string[],
      opts: CommandOpts,
    ): Promise<CommandFnResult> => {
      const fl = new FlagView(opts.flags, specOf('rm'))
      const force = fl.asBool('f')
      const verbose = fl.asBool('v')
      if (paths.length === 0) return rmWithoutOperands(force)
      const io = mountIo(opts)
      const unlink = requireOp(io.unlink, 'unlink')
      const resolved = await resolveGlobOf(io)(accessor, paths, opts.index ?? undefined)
      const verboseParts: string[] = []
      const errors: string[] = []
      for (const p of resolved) {
        try {
          await unlink(accessor, p)
        } catch (err) {
          const code = (err as { code?: string }).code
          if (force && (code === 'ENOENT' || code === 'ENOTDIR')) continue
          if (!isFsError(err)) throw err
          // GNU rm reports the operand and keeps removing the rest.
          errors.push(`rm: cannot remove '${p.rawPath}': ${String(fsStrerror(err))}`)
          continue
        }
        if (verbose) verboseParts.push(`removed '${p.rawPath}'`)
      }
      const output: ByteSource | null = verbose ? formatRecords(verboseParts) : null
      const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : undefined
      return [
        output,
        new IOResult({
          exitCode: errors.length > 0 ? 1 : 0,
          ...(stderr !== undefined ? { stderr } : {}),
        }),
      ]
    },
  })
}
