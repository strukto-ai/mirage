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

import type { MachineAccessor } from '../../accessor/machine.ts'
import type { ByteSource } from '../../io/types.ts'
import { refusal } from '../posix/errors.ts'
import { joinRoot } from '../posix/utils.ts'
import { PathSpec } from '../../types.ts'
import { norm, parent } from '../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'

/**
 * The virtual path of the mount root `path` is under. Mirrors Python's
 * `mount_prefix`.
 *
 * @param path a path on the mount.
 */
export function mountPrefix(path: PathSpec): string {
  const virtual = rstripSlash(path.virtual)
  return norm(virtual.slice(0, virtual.length - path.vfsPath.length) || '/')
}

/**
 * The folder a name is in, on the same mount; the mount's root for a name
 * at the root, and for the root itself.
 *
 * @param path a path on the mount.
 */
export function folderOf(path: PathSpec): PathSpec {
  const key = stripSlash(path.vfsPath)
  const virtual = key === '' ? mountPrefix(path) : parent(rstripSlash(path.virtual) || '/')
  const cut = key.lastIndexOf('/')
  return new PathSpec({
    virtual,
    directory: parent(virtual),
    vfsPath: cut === -1 ? '' : key.slice(0, cut),
  })
}

/**
 * The last name of a path on the mount, `/` for its root.
 *
 * @param path the path.
 */
export function leaf(path: PathSpec): string {
  const last = rstripSlash(path.mountPath).split('/').pop() ?? ''
  return last === '' ? '/' : last
}

/**
 * The virtual name a path on the machines has on the mount `path` is on;
 * null for one outside the mount's root. Mirrors Python's `virtual_path`.
 *
 * @param accessor the mount's machines.
 * @param path a path on the mount.
 * @param real an absolute path on the machines.
 */
export function virtualPath(
  accessor: MachineAccessor,
  path: PathSpec,
  real: string,
): string | null {
  const root = rstripSlash(accessor.root)
  if (root !== '' && real !== root && !real.startsWith(`${root}/`)) return null
  return norm(`${mountPrefix(path)}/${real.slice(root.length).replace(/^\/+/, '')}`)
}

/**
 * A mount path's path on the machines.
 *
 * @param accessor the mount's machines.
 * @param path the path on the mount.
 */
export function machinePath(accessor: MachineAccessor, path: PathSpec): string {
  return joinRoot(accessor.root, path.mountPath)
}

/**
 * Run one line on a machine and return its output; a line that fails
 * raises the error its first complaint names.
 *
 * @param accessor the mount's machines.
 * @param machine the machine's name.
 * @param command the line.
 * @param path the path a failure names.
 * @param stdin the bytes fed to the line.
 * @param bounded hold its output to the workspace's memory room, for a line
 *   that reads a file's content.
 */
export async function runChecked(
  accessor: MachineAccessor,
  machine: string,
  command: string,
  path: PathSpec,
  stdin: ByteSource | null = null,
  bounded = false,
): Promise<Uint8Array> {
  const [status, out, err] = await accessor.run(machine, command, stdin, bounded)
  if (status !== 0 || err.length > 0) throw refusal(path, err)
  return out
}
