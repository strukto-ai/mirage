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

import type { OutputEvent } from '@struktoai/mirage-core/io/types'
import type { MirageRemote } from '@struktoai/mirage-core/remote/client'
import type { FileStat } from '@struktoai/mirage-core/types'
import { gnuDirname } from '@struktoai/mirage-core/utils/path'
import type { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'

/**
 * The file calls `MirageExecutionEnv` makes, as one session makes them: a
 * workspace in this process answers them through its dispatcher, a remote
 * one through the server's VFS API.
 */
export interface EnvFiles {
  read(path: string): Promise<Uint8Array>
  /** A file's bytes in chunks, as the backend hands them out. */
  readStream(path: string): Promise<AsyncIterable<Uint8Array>>
  write(path: string, data: string | Uint8Array): Promise<void>
  /** Write a file from chunks as they arrive, replacing what it held. */
  writeStream(path: string, chunks: AsyncIterable<Uint8Array>): Promise<void>
  append(path: string, data: Uint8Array): Promise<void>
  stat(path: string, options?: { nofollow?: boolean; fresh?: boolean }): Promise<FileStat>
  readdir(path: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  isDir(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
  truncate(path: string, length: number): Promise<void>
  rename(source: string, destination: string): Promise<void>
  readlink(path: string): Promise<string>
  /** Whether a path is a mount root, or holds one. */
  holdsMount(path: string): Promise<boolean>
}

/** One command started with its output streamed, as `MirageExecutionEnv` drives it. */
export interface EnvExecution {
  readonly events: AsyncIterable<OutputEvent>
  /** The outcome; drain `events` first. */
  wait(): Promise<ExecuteResult>
  cancel(): void
}

/** The shell `MirageExecutionEnv` runs its commands in. */
export interface EnvShell {
  /** Run a housekeeping line, kept out of the session's history, and return its whole output. */
  run(line: string, options?: { cwd?: string }): Promise<ExecuteResult>
  /** Start a command with its output streamed. */
  stream(
    line: string,
    options: { cwd: string; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<EnvExecution>
}

/** Where `MirageExecutionEnv`'s files and commands go. */
export interface EnvWorld {
  /** Pi's file namespace: equal ids see the same files at the same paths. */
  readonly id: string
  readonly files: EnvFiles
  readonly shell: EnvShell
}

/**
 * Make a path's missing parents, as `mkdir -p` would, tolerating a racing
 * creator.
 *
 * @param files the calls to make them with.
 * @param path the path whose parents must exist.
 */
export async function ensureParents(files: EnvFiles, path: string): Promise<void> {
  const parent = gnuDirname(path)
  if (parent === '/' || parent === '' || parent === '.') return
  if (await files.exists(parent)) return
  await ensureParents(files, parent)
  try {
    await files.mkdir(parent)
  } catch (err) {
    if (!(await files.exists(parent))) throw err
  }
}

/**
 * Whether a source names a workspace on a Mirage server rather than one in
 * this process.
 *
 * @param source a workspace, or where a server's workspace lives.
 */
export function isRemote(source: unknown): source is MirageRemote {
  const named = source as Partial<MirageRemote>
  return typeof named.url === 'string' && typeof named.workspace === 'string'
}
