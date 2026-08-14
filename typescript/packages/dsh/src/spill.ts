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

import { Channel } from '@struktoai/mirage-core'

/** Where a spill sink writes: a workspace directory it can create and extend. */
export interface SpillTarget {
  ensureDir(dir: string): Promise<void>
  write(path: string, bytes: Uint8Array): Promise<void>
  append(path: string, bytes: Uint8Array): Promise<void>
}

/** The two directory facts `ensureDirPath` needs from a workspace. */
export interface DirMaker {
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
}

/**
 * Create `dir` and any missing ancestor, treating an existing one as
 * done.
 *
 * `mkdir` is one level and is not idempotent, so a probe alone is not
 * enough: two commands that first overrun at the same moment both see
 * the spill directory missing, one creates it and the other is refused
 * for a directory that is now exactly what it wanted. Losing that race
 * must not cost a command its spill, so the refusal is re-checked
 * against existence and only a directory that is still missing is a
 * real failure.
 *
 * @param dirs the workspace's `exists`/`mkdir`.
 * @param dir absolute workspace path to create.
 */
export async function ensureDirPath(dirs: DirMaker, dir: string): Promise<void> {
  let path = ''
  for (const part of dir.split('/').filter((p) => p !== '')) {
    path += `/${part}`
    if (await dirs.exists(path)) continue
    try {
      await dirs.mkdir(path)
    } catch (err) {
      if (!(await dirs.exists(path))) throw err
    }
  }
}

function totalLength(parts: Uint8Array[]): number {
  return parts.reduce((sum, p) => sum + p.byteLength, 0)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(totalLength(parts))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/**
 * Keeps the full, uncapped stdout and stderr of one command in workspace
 * files so a reader can recover output the delta budget dropped.
 *
 * Memory stays bounded: each channel buffers in memory only until the
 * delivered delta first overruns its budget, at which point `begin()`
 * flushes both buffers to their files and every later chunk appends
 * straight to the file. A write failure (no writable mount at the
 * configured path) disables the sink and leaves the paths undefined, the
 * honest "no safe path available" answer, so the process still streams,
 * just without a spill to point at.
 */
export class SpillSink {
  stdoutPath: string | undefined
  stderrPath: string | undefined

  private readonly target: SpillTarget
  private readonly dir: string
  private readonly base: string
  private started = false
  private failed = false
  private stdoutParts: Uint8Array[] = []
  private stderrParts: Uint8Array[] = []

  constructor(target: SpillTarget, dir: string, base: string) {
    this.target = target
    this.dir = dir
    this.base = base
  }

  /** Buffer a chunk before spill starts, or append it to the file after. */
  async ingest(channel: Channel, data: Uint8Array): Promise<void> {
    if (this.failed) return
    if (!this.started) {
      if (channel === Channel.STDERR) this.stderrParts.push(data)
      else this.stdoutParts.push(data)
      return
    }
    await this.appendFile(channel, data)
  }

  /** Flush the buffered streams to files; called once, on the first overrun. */
  async begin(): Promise<void> {
    if (this.started || this.failed) return
    try {
      await this.target.ensureDir(this.dir)
      if (totalLength(this.stdoutParts) > 0) {
        this.stdoutPath = `${this.dir}/${this.base}.stdout`
        await this.target.write(this.stdoutPath, concat(this.stdoutParts))
      }
      if (totalLength(this.stderrParts) > 0) {
        this.stderrPath = `${this.dir}/${this.base}.stderr`
        await this.target.write(this.stderrPath, concat(this.stderrParts))
      }
      this.started = true
      this.stdoutParts = []
      this.stderrParts = []
    } catch {
      this.disable()
    }
  }

  private async appendFile(channel: Channel, data: Uint8Array): Promise<void> {
    try {
      if (channel === Channel.STDERR) {
        if (this.stderrPath === undefined) {
          this.stderrPath = `${this.dir}/${this.base}.stderr`
          await this.target.write(this.stderrPath, data)
        } else {
          await this.target.append(this.stderrPath, data)
        }
      } else {
        if (this.stdoutPath === undefined) {
          this.stdoutPath = `${this.dir}/${this.base}.stdout`
          await this.target.write(this.stdoutPath, data)
        } else {
          await this.target.append(this.stdoutPath, data)
        }
      }
    } catch {
      this.disable()
    }
  }

  /**
   * Give up on spilling and report no path.
   *
   * Called on a write failure, and by a reader that discovers it lost
   * bytes before they ever reached here: a file missing the middle of
   * the stream is worse than no file, because the path presents it as
   * the whole one.
   */
  disable(): void {
    this.failed = true
    this.stdoutPath = undefined
    this.stderrPath = undefined
    this.stdoutParts = []
    this.stderrParts = []
  }
}
