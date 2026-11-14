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

import type { Context } from '@earendil-works/chord/context'
import type { FileChange, FileWatcher, WatchTarget } from '@earendil-works/pi-durable/env'
import { isEnotdir, isMissingPath } from '@struktoai/mirage-core/errors/fs'
import { FileType, type FileStat } from '@struktoai/mirage-core/types'
import { gnuDirname } from '@struktoai/mirage-core/utils/path'
import type { Files } from '@struktoai/mirage-core/workspace/files'
import { toFileError } from './errors.ts'

/** A watch target with its path resolved and its exclusions read once. */
export interface ResolvedTarget {
  path: string
  recursive: boolean
  hidden: boolean
  names: ReadonlySet<string>
}

/** Resolve `targets` against `resolve`, the environment's path rule. */
export function resolveTargets(
  targets: readonly WatchTarget[],
  resolve: (path: string) => string,
): ResolvedTarget[] {
  return targets.map((target) => ({
    path: resolve(target.path),
    recursive: target.recursive === true,
    hidden: target.exclude?.hidden === true,
    names: new Set(target.exclude?.names ?? []),
  }))
}

function signature(stat: FileStat): string {
  return [stat.type, stat.size, stat.modified, stat.fingerprint, stat.revision].join('\u0000')
}

async function statOrNull(read: () => Promise<FileStat>): Promise<FileStat | null> {
  try {
    return await read()
  } catch (error) {
    if (isMissingPath(error) || isEnotdir(error)) return null
    throw error
  }
}

async function visitDir(
  files: Files,
  dir: string,
  target: ResolvedTarget,
  seen: Map<string, string>,
  deep: boolean,
): Promise<void> {
  let entries: string[]
  try {
    entries = await files.readdir(dir)
  } catch (error) {
    if (isMissingPath(error) || isEnotdir(error)) return
    throw error
  }
  for (const path of entries) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if ((target.hidden && name.startsWith('.')) || target.names.has(name)) continue
    const stat = await statOrNull(() => files.stat(path, undefined, { nofollow: true }))
    if (stat === null) continue
    seen.set(path, signature(stat))
    if (deep && stat.type === FileType.DIRECTORY) await visitDir(files, path, target, seen, true)
  }
}

/** One snapshot of every watched path: its signature by path, absent paths left out. */
async function scan(
  files: Files,
  targets: readonly ResolvedTarget[],
): Promise<Map<string, string>> {
  const seen = new Map<string, string>()
  for (const target of targets) {
    const stat = await statOrNull(() => files.stat(target.path))
    if (stat === null) continue
    seen.set(target.path, signature(stat))
    if (stat.type === FileType.DIRECTORY)
      await visitDir(files, target.path, target, seen, target.recursive)
  }
  return seen
}

/**
 * The paths whose signature differs between two snapshots. A path that
 * appeared or vanished also changes the watched directory that lists it, so
 * a directory replaced at its own path is reported as itself.
 */
function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set<string>()
  for (const [path, sig] of after) if (before.get(path) !== sig) paths.add(path)
  for (const path of before.keys()) if (!after.has(path)) paths.add(path)
  for (const path of [...paths]) {
    if (before.has(path) === after.has(path)) continue
    const parent = gnuDirname(path)
    if (before.has(parent) || after.has(parent)) paths.add(parent)
  }
  return [...paths]
}

/**
 * A watcher that compares snapshots of the watched paths every
 * `intervalMs`. Mirage reaches its files through mounts that do not report
 * every change, so this is Pi's `polling` mode: a change undone between two
 * snapshots can be missed.
 */
export class PollingWatcher implements FileWatcher {
  readonly mode = 'polling'
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined

  private constructor(
    private readonly files: Files,
    private readonly targets: readonly ResolvedTarget[],
    private readonly onChange: (change: FileChange) => void,
    private readonly intervalMs: number,
    private snapshot: Map<string, string>,
  ) {}

  /** Establish coverage: the snapshot later changes are compared with, then the first poll. */
  static async open(
    files: Files,
    targets: readonly ResolvedTarget[],
    onChange: (change: FileChange) => void,
    intervalMs: number,
  ): Promise<PollingWatcher> {
    const watcher = new PollingWatcher(
      files,
      targets,
      onChange,
      intervalMs,
      await scan(files, targets),
    )
    watcher.schedule()
    return watcher
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.running = this.poll().finally(() => {
        this.running = undefined
      })
    }, this.intervalMs)
  }

  private deliver(change: FileChange): void {
    try {
      this.onChange(change)
    } catch (error) {
      console.debug(`watch listener failed: ${String(error)}`)
    }
  }

  private async poll(): Promise<void> {
    let next: Map<string, string>
    try {
      next = await scan(this.files, this.targets)
    } catch (error) {
      if (this.stopped) return
      this.stopped = true
      this.deliver({ kind: 'failed', error: toFileError(error) })
      return
    }
    if (this.stopped) return
    const paths = changed(this.snapshot, next)
    this.snapshot = next
    if (paths.length > 0) this.deliver({ kind: 'paths', paths })
    this.schedule()
  }

  async stop(_context: Context): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    await this.running
  }
}
