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

import type { ByteSlice, ByteSpool } from '../io/spool.ts'
import type { ChunkedHandle, OpenMode } from '../runtime/handles/index.ts'
import type { FileStat } from '../types.ts'

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

/** One open file, whichever entry point opened it. */
export interface Handle {
  path: string
  /**
   * Where the path really points once namespace links are followed; a file
   * whose name went keys the handles left on it alike.
   */
  key: string
  /**
   * What the open asked for: a handle that writes reads the stored bytes,
   * one that appends writes at the end.
   */
  mode: OpenMode
  data?: Uint8Array
  writeBuf?: [number, Uint8Array | ByteSlice][]
  /** Where its writes wait past what memory holds, and the bytes handed it. */
  spool?: ByteSpool
  spooled?: number
  live?: boolean
  /** A large file reads a chunk at a time rather than hydrating whole. */
  chunked?: ChunkedHandle
  /** Bumped whenever the file changes, so a first read that was out meanwhile does not keep its bytes. */
  generation?: number
  /**
   * The file's row as it was when its name was removed or replaced; the open
   * file has no path left. Unset while it has one.
   */
  detached?: FileStat
  /** The stored length the open saw, where an appending handle's writes start while it holds no bytes. */
  size?: number
  /**
   * The file's row as its last stat fetched it and when (`performance.now()`),
   * which a guest's fstat answers by for a moment while nothing changes the
   * file through the core.
   */
  row?: FileStat
  rowAt?: number
  /** Bumped whenever the core changes the file's row, so a stat that was out meanwhile does not keep the row it fetched. */
  restats?: number
  /**
   * Why the bytes its file had could not be kept when its name went; every
   * read through it reports it rather than read what the name holds now.
   */
  lost?: Error
}
