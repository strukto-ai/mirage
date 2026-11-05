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

import type { OpenMode } from '../handles/mode.ts'
import type { VFSStat } from '../types.ts'
import type { GuestCall } from './execution.ts'
import type { GuestFile, GuestView } from './fs.ts'

/** What carries a guest's calls to its host: a worker's blocking bridge. */
export type GuestCaller = (request: GuestCall) => unknown

/** One open file of the host's, its calls made through `call`. */
function guestFile(
  call: GuestCaller,
  id: number,
  mode: OpenMode,
  opened: string,
  inode: string,
): GuestFile {
  const on = (method: string, ...args: unknown[]): unknown =>
    call({ op: 'file', file: id, method, args })
  return {
    mode,
    opened,
    inode,
    path: () => on('path') as string,
    position: () => on('position') as number,
    size: () => on('size') as number,
    read: (size) => on('read', size) as Uint8Array,
    pread: (offset, size) => on('pread', offset, size) as Uint8Array,
    write: (data) => on('write', data),
    pwrite: (offset, data) => on('pwrite', offset, data),
    seek: (offset, whence) => on('seek', offset, whence) as number | null,
    truncate: (size) => on('truncate', size),
    land: () => on('land'),
    close: () => on('close'),
    fstat: () => on('fstat') as VFSStat,
    unlinked: () => on('unlinked') as boolean,
  }
}

/**
 * The run's view as its guest sees it, each call made through `call`, which
 * blocks on the worker's bridge for the answer.
 *
 * @param call - carries one call to the host.
 */
export function guestView(call: GuestCaller): GuestView {
  const viewCall = (method: string, ...args: unknown[]): unknown =>
    call({ op: 'view', method, args })
  return {
    stat: (path) => viewCall('stat', path) as VFSStat,
    lstat: (path) => viewCall('lstat', path) as VFSStat,
    statOrNull: (path, nofollow = false) =>
      viewCall('statOrNull', path, nofollow) as VFSStat | null,
    open: (path, mode) => {
      const { id, opened, inode } = viewCall('open', path, mode) as {
        id: number
        opened: string
        inode: string
      }
      return guestFile(call, id, mode, opened, inode)
    },
    unlink: (path) => viewCall('unlink', path),
    mkdir: (path) => viewCall('mkdir', path),
    rmdir: (path) => viewCall('rmdir', path),
    rename: (src, dst) => viewCall('rename', src, dst),
    symlink: (path, target) => viewCall('symlink', path, target),
    walked: (path, follow = true) => viewCall('walked', path, follow) as string,
    readlink: (path) => viewCall('readlink', path) as string,
    setattr: (path, atime, mtime, nofollow) => viewCall('setattr', path, atime, mtime, nofollow),
    readdir: (path) => viewCall('readdir', path) as [string, number][],
  }
}
