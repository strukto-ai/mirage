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
// mounted path and a refused one answers its condition there; any other
// keeps node's function. A sync spelling refuses a mounted path, since
// the workspace answers asynchronously. constants.test.ts lists the
// names that keep node's function on purpose, because nothing they take
// is a path a mount could serve, and fails on any other, which would
// keep node's own answer with a mounted path in hand.
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

// The calls that open a mounted path onto a descriptor of the patch's
// own (descriptors.ts): `open` in its spellings, and node's read and write
// streams, whose descriptor calls the patch answers through their `fs`
// option.
export const OPENED_CALLS = ['open', 'createReadStream', 'createWriteStream'] as const

// The calls that take a descriptor rather than a path: they answer for a
// descriptor `open` handed out and leave every other one to node. fchmod,
// fchown and futimes are among them so a mounted descriptor never reaches
// the device that holds its number.
export const DESCRIPTOR_CALLS = [
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
  'write',
  'writev',
] as const

// Watchers have no workspace twin. A hard link answers EPERM, as link(2)
// does on a filesystem without them.
export const REFUSED_CALLS: Readonly<Record<string, FsCondition>> = {
  cp: 'ENOTSUP',
  glob: 'ENOTSUP',
  link: HARD_LINK_REFUSAL,
  mkdtemp: 'ENOTSUP',
  mkdtempDisposable: 'ENOTSUP',
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
