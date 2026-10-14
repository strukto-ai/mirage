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

import { IOResult } from '../../../io/types.ts'
import { FileType, type FileStat, type PathSpec } from '../../../types.ts'
import { isEnoent, isFsError } from '../../../errors/fs.ts'
import type { CommandFnResult } from '../../config.ts'
import { UsageError } from '../../errors.ts'
import { descendantPath } from '../utils/paths.ts'
import type { NamespaceView } from '../../../view/types.ts'

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
