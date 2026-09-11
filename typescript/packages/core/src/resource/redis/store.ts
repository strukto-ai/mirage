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

/**
 * The keyspace a redis mount is built on, as the ops see it.
 *
 * Every op under `core/redis/` reaches redis through this surface and
 * nothing else, so the transport is the store's business: node speaks RESP
 * over a socket, the browser speaks the Upstash REST shape over fetch, and
 * the ops cannot tell which. Paths are mount-relative and values are bytes.
 *
 * The key layout is shared by every implementation and by python, so two
 * runtimes pointed at one server serve one filesystem: `<prefix>file:<path>`
 * holds the bytes, `<prefix>dir` is the set of every directory,
 * `<prefix>modified:<path>` the ISO mtime and `<prefix>attrs:<path>` a hash
 * carrying the stat overlay.
 */
export interface RedisRestore {
  files: Record<string, Uint8Array>
  dirs: readonly string[]
  attrs: Record<string, Record<string, string>>
  modified: Record<string, string>
}

export interface RedisStoreLike {
  readonly url: string
  readonly keyPrefix: string
  /** Connect if the transport needs to, and make sure `/` is a directory. */
  open(): Promise<void>
  getFile(path: string): Promise<Uint8Array | null>
  /** A byte window, or null when the file is absent; a null `size` reads to the end. */
  getFileRange(path: string, offset: number, size: number | null): Promise<Uint8Array | null>
  setFile(path: string, data: Uint8Array): Promise<void>
  delFile(path: string): Promise<void>
  hasFile(path: string): Promise<boolean>
  /** Every file path on the mount sorted by code point, narrowed by `prefix` when given. */
  listFiles(prefix?: string): Promise<string[]>
  fileLen(path: string): Promise<number>
  hasDir(path: string): Promise<boolean>
  addDir(path: string): Promise<void>
  removeDir(path: string): Promise<void>
  listDirs(): Promise<Set<string>>
  getModified(path: string): Promise<string | null>
  setModified(path: string, ts: string): Promise<void>
  delModified(path: string): Promise<void>
  getAttrs(path: string): Promise<Record<string, string>>
  setAttrs(path: string, fields: Record<string, string>): Promise<void>
  delAttrs(path: string): Promise<void>
  listAttrs(): Promise<Record<string, Record<string, string>>>
  listModified(): Promise<Record<string, string>>
  /** Drop every key of this mount. */
  /**
   * Write a whole snapshot in as few round trips as the transport allows:
   * node queues everything into one MULTI, the browser pipelines the side
   * keys under the REST request cap and sends each file's bytes on its own.
   */
  restore(state: RedisRestore): Promise<void>
  clear(): Promise<void>
  close(): Promise<void>
}
