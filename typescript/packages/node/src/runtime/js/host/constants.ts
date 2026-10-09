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

import type { FsCondition } from '@struktoai/mirage-core/errors/types'
import { HARD_LINK_REFUSAL } from '@struktoai/mirage-core/runtime/constants'

// The node fs functions the patch answers, by name, the way python's
// runtime/python/host/constants.py classifies `os`. A name covers its
// three spellings (`fs.promises.x`, the callback `fs.x`, `fs.xSync`),
// whichever node has. A routed name goes through the workspace on a
// mounted path, a refused one answers its condition there, and a
// passthrough name keeps node's function because nothing it takes is a
// path a mount could serve. A sync spelling refuses a mounted path,
// since the workspace answers asynchronously. A path-taking function in
// none of the three would keep node's own answer with a mounted path in
// hand, which is why constants.test.ts fails on any such name.
export const ROUTED_CALLS = [
  'access',
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'exists',
  'lchmod',
  'lchown',
  'lstat',
  'lutimes',
  'mkdir',
  'readFile',
  'readdir',
  'readlink',
  'rename',
  'rm',
  'rmdir',
  'stat',
  'symlink',
  'truncate',
  'unlink',
  'utimes',
  'writeFile',
] as const

export type RoutedCall = (typeof ROUTED_CALLS)[number]

// Descriptors, streams and watchers have no workspace twin: serving them
// means a descriptor table the host can see, which only the runtimes'
// handles build. A hard link answers EPERM, as link(2) does on a
// filesystem without them.
export const REFUSED_CALLS: Readonly<Record<string, FsCondition>> = {
  cp: 'ENOTSUP',
  createReadStream: 'ENOTSUP',
  createWriteStream: 'ENOTSUP',
  glob: 'ENOTSUP',
  link: HARD_LINK_REFUSAL,
  mkdtemp: 'ENOTSUP',
  mkdtempDisposable: 'ENOTSUP',
  open: 'ENOTSUP',
  openAsBlob: 'ENOTSUP',
  opendir: 'ENOTSUP',
  realpath: 'ENOTSUP',
  statfs: 'ENOTSUP',
  watch: 'ENOTSUP',
  watchFile: 'ENOTSUP',
}

// The refused calls whose function argument is a listener rather than a
// callback (`fs.watch`, `fs.watchFile`): node answers their failure by
// throwing, so the refusal throws too instead of calling the listener.
export const LISTENED_CALLS: ReadonlySet<string> = new Set(['watch', 'watchFile'])

// Descriptor calls take an fd, which a mounted path never opens, and
// unwatchFile undoes a watch that could not have started on a mount.
export const PASSTHROUGH_CALLS: ReadonlySet<string> = new Set([
  '_toUnixTimestamp',
  'close',
  'fchmod',
  'fchown',
  'fdatasync',
  'fstat',
  'fsync',
  'ftruncate',
  'futimes',
  'read',
  'readv',
  'unwatchFile',
  'write',
  'writev',
])

// The argument positions that name a path, for the calls that take more
// than the first: both ends of a move or copy, and a symlink's own
// location (its target is stored as typed and never routed).
export const PATH_ARGS: Readonly<Record<string, readonly number[]>> = {
  copyFile: [0, 1],
  cp: [0, 1],
  link: [0, 1],
  rename: [0, 1],
  symlink: [1],
}
