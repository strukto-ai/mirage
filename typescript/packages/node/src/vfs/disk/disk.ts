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

import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { VFSConfigError } from '@struktoai/mirage-core/vfs/errors'
import {
  chmod,
  copyFile,
  mkdir,
  stat as fsStat,
  statfs as fsStatfs,
  writeFile,
} from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'

import { CapacityState, ListingVersion, PathSpec, VFSName } from '@struktoai/mirage-core/types'
import type { CapacityResult } from '@struktoai/mirage-core/types'

import { DISK_COMMANDS } from '../../commands/builtin/disk/index.ts'

import { readEntries, resolveInside } from '../../core/disk/utils.ts'
import { DiskAccessor } from '../../accessor/disk.ts'
import { DISK_OPS } from '../../ops/disk/index.ts'
import { PROMPT } from './prompt.ts'
import { type DeltaHook } from '@struktoai/mirage-core/watch/index'
import { buildDeltaHook } from '../../core/disk/watch/index.ts'

export interface DiskVFSOptions {
  root: string
  // Store each listing at its folder's version. Folder versions assume a
  // local POSIX filesystem; turn them off for an NFS, SMB or FUSE root, whose
  // change times may not move with the folder's entries.
  folderVersions?: boolean
}

export interface DiskVFSState {
  type: string
  config?: { root: string; folderVersions: boolean }
  /**
   * Each file as bytes, or as a host path read by whoever consumes the
   * state (a snapshot tar, a copy).
   */
  files: Record<string, Uint8Array | string>
  modes?: Record<string, number>
}

async function walkFiles(current: string, out: string[]): Promise<void> {
  const entries = await readEntries(current)
  for (const e of entries) {
    const child = path.join(current, e.name)
    if (e.isDirectory()) {
      await walkFiles(child, out)
    } else if (e.isFile()) {
      out.push(child)
    }
  }
}

export class DiskVFS extends BaseVFS {
  override readonly name = VFSName.DISK
  override readonly cachesReads: boolean = false
  // byte store: stat() sizes every file from metadata
  override readonly sizesAlwaysKnown: boolean = true
  override readonly indexTtl: number = 60
  override readonly prompt = PROMPT
  // Each folder's listing is stored at the folder's own version (inode and
  // change times, core/disk/listing_version.ts), so a fresh mount re-lists
  // only the folders that changed. An instance built with folderVersions
  // false declares NONE for itself; the initializer keeps FOLDER for the spec.
  override readonly listingVersion: ListingVersion = ListingVersion.FOLDER
  readonly root: string
  readonly folderVersions: boolean
  override readonly accessor: DiskAccessor

  constructor(options: DiskVFSOptions) {
    let folderVersions: unknown = options.folderVersions
    if (folderVersions === undefined) folderVersions = true
    if (typeof folderVersions !== 'boolean') {
      throw new VFSConfigError('disk: folder_versions: must be a boolean')
    }
    super()
    this.folderVersions = folderVersions
    if (!folderVersions) this.listingVersion = ListingVersion.NONE
    this.root = path.resolve(options.root)
    mkdirSync(this.root, { recursive: true })
    this.accessor = new DiskAccessor(this.root, folderVersions)
  }

  // The resolved root is the storage: two DiskVFS instances built on the same
  // directory are one store, however they were spelled.
  override storageLocation(): string {
    return `${this.name}:${this.root}`
  }

  // A real filesystem reports real numbers (QUOTA). GNU df: used counts
  // reserved blocks (blocks - bfree), available excludes them (bavail).
  override async capacity(): Promise<CapacityResult> {
    const st = await fsStatfs(this.root)
    const bsize = st.bsize
    return {
      state: CapacityState.QUOTA,
      total: st.blocks * bsize,
      used: (st.blocks - st.bfree) * bsize,
      available: st.bavail * bsize,
      inodes: st.files,
      inodesUsed: st.files - st.ffree,
      inodesFree: st.ffree,
    }
  }

  override ops(): readonly RegisteredOp[] {
    return DISK_OPS
  }

  override commands(): readonly RegisteredCommand[] {
    return DISK_COMMANDS
  }

  override deltaHook(): DeltaHook {
    return buildDeltaHook(this.accessor)
  }

  override async getState(): Promise<DiskVFSState> {
    await mkdir(this.root, { recursive: true })
    const files: Record<string, string> = {}
    const modes: Record<string, number> = {}
    const fileList: string[] = []
    await walkFiles(this.root, fileList)
    for (const full of fileList) {
      const rel = path.relative(this.root, full).split(path.sep).join('/')
      // By reference: the consumer reads each file, one at a time, so
      // capturing a large tree costs no memory. It keeps the files still
      // until it has read them.
      files[rel] = full
      // Capture the real inode mode: it is the base truth for disk
      // permissions (the sidecar is gone), so restore must reapply it or
      // a chmod would reset to the host umask.
      modes[rel] = (await fsStat(full)).mode & 0o7777
    }
    return {
      type: this.name,
      config: { root: this.root, folderVersions: this.folderVersions },
      files,
      modes,
    }
  }

  override async loadState(state: DiskVFSState): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const [rel, data] of Object.entries(state.files)) {
      if (path.isAbsolute(rel)) throw new Error(`snapshot path must be relative: ${rel}`)
      const full = await resolveInside(this.root, PathSpec.fromStrPath('/' + rel), rel)
      await mkdir(path.dirname(full), { recursive: true })
      // A host path (a staged restore, another disk mount's state) is
      // copied; one that already is the target (a copy over the same root)
      // is left alone.
      if (typeof data !== 'string') await writeFile(full, data)
      else if (path.resolve(data) !== path.resolve(full)) await copyFile(data, full)
      const mode = state.modes?.[rel]
      if (mode !== undefined) await chmod(full, mode)
    }
  }
}
