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
import type { Answer, GuestFile, GuestView } from './fs.ts'

/** What carries a guest's calls to its host: a worker's blocking bridge, or the isolate's own loop. */
export type GuestCaller = (request: GuestCall) => Answer<unknown>

/** An answer handed on, at once when it is at hand. */
function then<T, U>(value: Answer<T>, next: (answer: T) => U): Answer<U> {
  const pending = value as { then?: unknown }
  if (typeof pending.then === 'function') return (value as PromiseLike<T>).then(next)
  return next(value as T)
}

/** One open file of the host's, its calls made through `call`. */
function guestFile(
  call: GuestCaller,
  id: number,
  mode: OpenMode,
  opened: string,
  inode: string,
): GuestFile {
  const on = (method: string, ...args: unknown[]): Answer<unknown> =>
    call({ op: 'file', file: id, method, args })
  return {
    mode,
    opened,
    inode,
    path: () => on('path') as Answer<string>,
    position: () => on('position') as Answer<number>,
    size: () => on('size') as Answer<number>,
    read: (size) => on('read', size) as Answer<Uint8Array>,
    pread: (offset, size) => on('pread', offset, size) as Answer<Uint8Array>,
    write: (data) => on('write', data) as Answer<void>,
    pwrite: (offset, data) => on('pwrite', offset, data) as Answer<void>,
    seek: (offset, whence) => on('seek', offset, whence) as Answer<number | null>,
    truncate: (size) => on('truncate', size) as Answer<void>,
    land: () => on('land') as Answer<void>,
    close: () => on('close') as Answer<void>,
    fstat: () => on('fstat') as Answer<VFSStat>,
    unlinked: () => on('unlinked') as Answer<boolean>,
  }
}

/**
 * The run's view as its guest sees it, each call made through `call`: a
 * worker blocks on its bridge for the answer, and a guest in the host's
 * own isolate is handed the promise.
 *
 * @param call - carries one call to the host.
 */
export function guestView(call: GuestCaller): GuestView {
  const viewCall = (method: string, ...args: unknown[]): Answer<unknown> =>
    call({ op: 'view', method, args })
  return {
    stat: (path) => viewCall('stat', path) as Answer<VFSStat>,
    lstat: (path) => viewCall('lstat', path) as Answer<VFSStat>,
    statOrNull: (path, nofollow = false) =>
      viewCall('statOrNull', path, nofollow) as Answer<VFSStat | null>,
    open: (path, mode) =>
      then(
        viewCall('open', path, mode) as Answer<{ id: number; opened: string; inode: string }>,
        ({ id, opened, inode }) => guestFile(call, id, mode, opened, inode),
      ),
    unlink: (path) => viewCall('unlink', path) as Answer<void>,
    mkdir: (path) => viewCall('mkdir', path) as Answer<void>,
    rmdir: (path) => viewCall('rmdir', path) as Answer<void>,
    rename: (src, dst) => viewCall('rename', src, dst) as Answer<void>,
    symlink: (path, target) => viewCall('symlink', path, target) as Answer<void>,
    walked: (path, follow = true) => viewCall('walked', path, follow) as Answer<string>,
    readlink: (path) => viewCall('readlink', path) as Answer<string>,
    setattr: (path, atime, mtime, nofollow) =>
      viewCall('setattr', path, atime, mtime, nofollow) as Answer<void>,
    readdir: (path) => viewCall('readdir', path) as Answer<[string, number][]>,
  }
}
