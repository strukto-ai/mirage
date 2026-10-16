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

import {
  FileChangeKind,
  type FileEvent,
  type JsonValue,
  type PathSpec,
} from '@struktoai/mirage-core/types'
import { eventAt, textField } from '@struktoai/mirage-core/events/index'
import path from 'node:path'
import type { DiskAccessor } from '../../../accessor/disk.ts'
import { DISK_KINDS } from './constants.ts'

/**
 * Map one local filesystem notification onto mount paths.
 *
 * Mirage runs no watcher of its own: the consumer owns the inotify / FSEvents
 * / ReadDirectoryChangesW loop (chokidar, `fs.watch`, or the raw syscall) and
 * forwards what it saw, which keeps the dependency out of the package and lets
 * a deployment pick its own mechanism.
 *
 * `eventType` is one of `created`, `modified`, `deleted` or `moved`, so a
 * consumer translates its library's spelling once (chokidar's `add`/`addDir`
 * are `created`, `unlink`/`unlinkDir` are `deleted`, `change` is `modified`).
 * Any other name maps to nothing, because a watcher reports events this mount
 * has no opinion about.
 *
 * `payload` carries the host absolute paths the event named:
 * `{src_path, dest_path, is_directory}`. Those are watchdog's own field names,
 * taken verbatim from `FileSystemEvent` so the two languages accept the same
 * body and a python consumer can forward an event as a dict without renaming.
 *
 * Mirrors Python `DiskEventHook` (`core/disk/events/hook.py`).
 */
export class DiskEventHook {
  private readonly accessor: DiskAccessor

  constructor(accessor: DiskAccessor) {
    this.accessor = accessor
  }

  /**
   * Mount-relative form of a host path, or null if outside the mount.
   *
   * A watcher may be rooted above the mount, so an event for a sibling
   * directory is not this mount's to report.
   */
  private relative(hostPath: string): string | null {
    const root = path.resolve(this.accessor.root)
    const resolved = path.resolve(hostPath)
    if (resolved === root) return '/'
    if (!resolved.startsWith(root + path.sep)) return null
    return (
      '/' +
      resolved
        .slice(root.length + 1)
        .split(path.sep)
        .join('/')
    )
  }

  /**
   * Map a rename, which may cross the mount boundary either way.
   *
   * A watcher rooted above the mount sees renames that only half belong here,
   * and each half has to be reported on its own terms: a move out is a DELETE
   * of the vacated path, and a move in is a CREATE of the arrival. Reporting
   * neither (which discarding the event on an out-of-mount source does) leaves
   * a file sitting in the mount that no listing knows about.
   */
  private moved(
    root: PathSpec,
    source: string | null,
    target: string | null,
  ): readonly FileEvent[] {
    const movedFrom = source === null ? null : this.relative(source)
    const movedTo = target === null ? null : this.relative(target)
    if (movedTo === null) {
      if (movedFrom === null) return []
      return [eventAt(root, movedFrom, FileChangeKind.DELETE)]
    }
    if (movedFrom === null) return [eventAt(root, movedTo, FileChangeKind.CREATE)]
    return [eventAt(root, movedTo, FileChangeKind.MOVE, movedFrom)]
  }

  /**
   * Map one filesystem notification to the change it implies.
   *
   * A directory's own `modified` stays an UPDATE rather than becoming UNKNOWN:
   * inotify raises it whenever a child appears or vanishes, and it also
   * delivers that child's own event, so re-inventorying the subtree on every
   * write inside a directory would throw away the whole cache for nothing.
   */
  toEvents(root: PathSpec, eventType: string, payload: JsonValue): Promise<readonly FileEvent[]> {
    const source = textField(payload, 'src_path')
    if (eventType === 'moved') {
      return Promise.resolve(this.moved(root, source, textField(payload, 'dest_path')))
    }
    if (source === null) return Promise.resolve([])
    const relative = this.relative(source)
    if (relative === null) return Promise.resolve([])
    const kind = DISK_KINDS[eventType]
    if (kind === undefined) return Promise.resolve([])
    return Promise.resolve([eventAt(root, relative, kind)])
  }
}
