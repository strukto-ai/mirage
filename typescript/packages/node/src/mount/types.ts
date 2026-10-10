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

import type { ChunkedHandle } from '@struktoai/mirage-core/runtime/handles/index'

/**
 * One entry's POSIX attributes, as every adapter over the core needs them:
 * the libfuse adapter hands them to fuse-native, SFTP and codex-exec read
 * the fields. Mirrors Python's `MountAttrs`.
 */
export interface MountAttrs {
  mtime: Date
  atime: Date
  ctime: Date
  nlink: number
  size: number
  mode: number
  uid: number
  gid: number
  rdev: number
}

/** One open file of a kernel mount. */
export interface Handle {
  path: string
  /** Where the path really points once namespace links are followed. */
  key: string
  data?: Uint8Array
  writeBuf?: [number, Uint8Array][]
  live?: boolean
  /** A large file reads a chunk at a time rather than hydrating whole. */
  chunked?: ChunkedHandle
  /** Bumped whenever the file changes, so a first read that was out meanwhile does not keep its bytes. */
  generation?: number
  /** Its name was removed or replaced: the open file has no path left. */
  detached?: boolean
}
