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

/** Stats a directory listing runs at once. Mirrors Python's LISTING_CONCURRENCY. */
export const LISTING_CONCURRENCY = 16

/**
 * How long a guest's fstat answers by the row its handle last fetched, as
 * FUSE's attr_timeout does for a kernel: CPython's open() and read() stat
 * the descriptor again right after the open. Mirrors Python's
 * FSTAT_ROW_SECONDS.
 */
export const FSTAT_ROW_SECONDS = 1

// SFTP v3 open flags and status codes, fixed by the protocol draft.
export const OPEN = {
  READ: 0x01,
  WRITE: 0x02,
  APPEND: 0x04,
  CREAT: 0x08,
  TRUNC: 0x10,
  EXCL: 0x20,
} as const
export const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  OP_UNSUPPORTED: 8,
} as const

// The extension a machine's sshfs renames with when the server names it,
// replacing what the new name held as rename(2) does: SFTP v3's own rename
// refuses an existing target, so without it `mv` over a file, git and every
// save through a temporary file fail there. ssh2's VERSION names no extension,
// so a machine's pipe adds it. Mirrors Python's `POSIX_RENAME`.
export const POSIX_RENAME = 'posix-rename@openssh.com'

// The size ssh2's SFTP class cuts each answer to on a sandbox's pipe.
export const PIPE_PACKET_SIZE = 64 * 1024

// How long a machine's kernel keeps what a mount served into it answered of a
// name, its absence or its attributes (sshfs's entry, negative and attr
// timeouts), so the folder checks an import repeats stay on the machine. What
// another changed in that time is waited out before a program starts there
// (`RecentChanges`). Mirrors Python's `KERNEL_CACHE_SECONDS`.
export const KERNEL_CACHE_SECONDS = 1

// The fsproto version a host and a machine's mirage-fuse must share
// (`mount/fsproto`). Mirrors Python's `FSPROTO_VERSION`.
export const FSPROTO_VERSION = 1

// The largest fsproto frame either side accepts.
export const FSPROTO_FRAME_BYTES = 64 * 1024 * 1024

// The largest file read whole for mirage-fuse's cache, and the files and
// total a folder's prefetch carries. Mirror Python's constants.
export const FSPROTO_WHOLE_BYTES = 8 * 1024 * 1024
export const FSPROTO_FETCH_FILE_BYTES = 256 * 1024
export const FSPROTO_FETCH_DIR_BYTES = 4 * 1024 * 1024

// The entries a folder's first listing carries for the folders under it,
// so mirage-fuse walks a kept tree in a few round trips. Mirrors Python's.
export const FSPROTO_TREE_ENTRIES = 20000
