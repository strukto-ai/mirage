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

import { type PathSpec, type WalkEntry } from '@struktoai/mirage-core/types'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { stripSlash } from '@struktoai/mirage-core/utils/slash'
import {
  type DeltaHook,
  ListingDeltaHook,
  statFingerprint,
} from '@struktoai/mirage-core/watch/index'
import type { FileEntryWithStats, SFTPWrapper } from 'ssh2'
import type { SSHAccessor } from '../../accessor/ssh.ts'
import { isNoSuchFile, joinRoot } from './utils.ts'

function listDir(sftp: SFTPWrapper, remote: string): Promise<FileEntryWithStats[]> {
  return new Promise<FileEntryWithStats[]>((resolveFn, rejectFn) => {
    sftp.readdir(remote, (err, entries) => {
      // A directory that vanished mid-walk is not an error: the next
      // pull reports the DELETE from the snapshot diff.
      if (err !== undefined) {
        if (isNoSuchFile(err)) resolveFn([])
        else rejectFn(err)
        return
      }
      resolveFn(entries)
    })
  })
}

async function* descend(
  sftp: SFTPWrapper,
  root: string,
  relative: string,
): AsyncGenerator<WalkEntry> {
  const entries = await listDir(sftp, joinRoot(root, relative))
  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') continue
    const base = relative === '/' ? '' : relative
    const child = `${base}/${entry.filename}`
    if (entry.attrs.isDirectory()) {
      yield { virtual: child, isDir: true, fingerprint: null }
      yield* descend(sftp, root, child)
      continue
    }
    // Checkpoints persist this spelling as part of the fingerprint.
    const modified = new Date(entry.attrs.mtime * 1000).toISOString()
    yield {
      virtual: child,
      isDir: false,
      fingerprint: statFingerprint(null, modified, entry.attrs.size),
      size: entry.attrs.size,
      modified,
    }
  }
}

/**
 * Recursive SFTP descent feeding the generic listing differ.
 *
 * Reads the remote host directly, never through mirage's caches, as the
 * DeltaHook contract requires. Fingerprints on mtime, the same value `ssh` stat
 * reports.
 *
 * Unlike the object stores, this costs one round trip per directory, because
 * SFTP has no recursive listing to ask for. Poll cadence should account for the
 * shape of the tree.
 */
class SSHWalk {
  private readonly accessor: SSHAccessor

  constructor(accessor: SSHAccessor) {
    this.accessor = accessor
  }

  async *walk(root: PathSpec): AsyncGenerator<WalkEntry> {
    const prefix = mountPrefixOf(root.virtual, root.vfsPath)
    const sftp = await this.accessor.sftp()
    const start = `/${stripSlash(root.mountPath)}`
    for await (const entry of descend(sftp, this.accessor.config.root ?? '/', start)) {
      yield {
        ...entry,
        virtual: prefix !== '' ? `${prefix}${entry.virtual}` : entry.virtual,
      }
    }
  }
}

export function buildDeltaHook(accessor: SSHAccessor): DeltaHook {
  const walk = new SSHWalk(accessor)
  return new ListingDeltaHook(walk.walk.bind(walk))
}
