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

import { MachineAccessor } from '../../accessor/machine.ts'
import { capacity as machineCapacity } from '../../core/machine/capacity.ts'
import { checksum as machineChecksum } from '../../core/machine/checksum.ts'
import { copy as machineCopy, dirCopy as machineDirCopy } from '../../core/machine/copy.ts'
import { create as machineCreate } from '../../core/machine/create.ts'
import { mkdir as machineMkdir } from '../../core/machine/mkdir.ts'
import { holder, holders, lands, stage } from '../../core/machine/place.ts'
import { pwrite as machinePwrite } from '../../core/machine/pwrite.ts'
import {
  firstLines as machineFirstLines,
  lastLines as machineLastLines,
  lineCount as machineLineCount,
  read as machineRead,
} from '../../core/machine/read.ts'
import { readdir as machineReaddir } from '../../core/machine/readdir.ts'
import { rename as machineRename } from '../../core/machine/rename.ts'
import { rmR as machineRmR } from '../../core/machine/rm.ts'
import { rmdir as machineRmdir } from '../../core/machine/rmdir.ts'
import { filesContaining as machineFilesContaining } from '../../core/machine/search.ts'
import { setAttrs as machineSetAttrs } from '../../core/machine/set_attrs.ts'
import {
  leadsToHidden,
  restricted,
  stat as machineStat,
  tree as machineTree,
} from '../../core/machine/stat.ts'
import { truncate as machineTruncate } from '../../core/machine/truncate.ts'
import { unlink as machineUnlink } from '../../core/machine/unlink.ts'
import { write as machineWrite } from '../../core/machine/write.ts'
import { eisdir, enoent, enotdir, enotempty, exdev } from '../../errors/fs.ts'
import type { MachineTable } from '../../execution/machine/table.ts'
import type { ByteSource } from '../../io/types.ts'
import {
  FileType,
  PathSpec,
  VFSName,
  type CapacityResult,
  type FileStat,
  type SetAttrFields,
} from '../../types.ts'
import { norm } from '../../utils/path.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { BaseVFS } from '../base.ts'
import { LOCAL_WALK_LIMIT } from '../constants.ts'
import type { RedactedSchema } from '../secrets.ts'
import type { ConfigState, Handed } from '../types.ts'
import { MachineVFSConfig } from './config.ts'

/**
 * A machine's own files at a prefix, reached through the exec the workspace
 * already holds for the machine: what its programs read and write, without
 * serving or copying anything.
 *
 * On several machines each op picks where it acts: a name is read, removed
 * or renamed on the machine holding it, a new name lands on the machine
 * running the command's program, else on `defaultMachine`, and a directory
 * lists every machine's entries once. `"@<machine>"` in a mount table is
 * this VFS over that machine at the same path, so Mirage and the machine's
 * programs name a file the same way. Mirrors Python's `MachineVFS`.
 */
export class MachineVFS extends BaseVFS {
  override readonly name = VFSName.MACHINE
  // Programs change these files behind Mirage's back.
  override readonly cachesReads: boolean = false
  override readonly indexTtl: number = 0
  override readonly sizesAlwaysKnown: boolean = true
  override readonly readsRanges: boolean = true
  override walkLimit: number = LOCAL_WALK_LIMIT
  readonly config: MachineVFSConfig
  override readonly accessor: MachineAccessor

  constructor(config: MachineVFSConfig) {
    super()
    this.config = config
    this.accessor = new MachineAccessor(config)
  }

  /**
   * Reach the workspace's machines once it has them.
   *
   * @param machines the workspace's machines.
   * @param fallback where a new name lands when the config names no
   *   `defaultMachine`.
   */
  bindMachines(machines: MachineTable, fallback: string): void {
    this.accessor.bindMachines(machines, fallback)
  }

  /**
   * Whether the mount shows a machine its own files at the path they have
   * there, so serving the prefix back to the machine would cover them.
   *
   * @param machine the machine's name.
   * @param prefix the mount's prefix.
   */
  showsOwn(machine: string, prefix: string): boolean {
    return norm(this.config.root ?? '/') === norm(prefix) && this.accessor.names().includes(machine)
  }

  override async readdir(path: PathSpec): Promise<FileStat[]> {
    await this.shown(path)
    return machineReaddir(this.accessor, this.accessor.names(), path)
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    await this.shown(path)
    const held = await holders(this.accessor, path)
    const [first] = held
    if (first === undefined) throw enoent(path)
    const running = stage(this.accessor)
    return machineStat(
      this.accessor,
      running !== null && held.includes(running) ? running : first,
      path,
    )
  }

  override async read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> {
    await this.shown(path)
    return machineRead(this.accessor, await holder(this.accessor, path), path, offset, size)
  }

  override async firstLines(path: PathSpec, n: number): Promise<Uint8Array | null> {
    await this.shown(path)
    return machineFirstLines(this.accessor, await holder(this.accessor, path), path, n)
  }

  override async lastLines(path: PathSpec, n: number): Promise<Uint8Array | null> {
    await this.shown(path)
    return machineLastLines(this.accessor, await holder(this.accessor, path), path, n)
  }

  override async lineCount(path: PathSpec): Promise<number | null> {
    await this.shown(path)
    return machineLineCount(this.accessor, await holder(this.accessor, path), path)
  }

  override async checksum(path: PathSpec, algorithm: string): Promise<string | null> {
    await this.shown(path)
    return machineChecksum(this.accessor, await holder(this.accessor, path), path, algorithm)
  }

  override async readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    if (restricted(path)) return null
    return machineTree(this.accessor, await this.everywhere(path), path)
  }

  override async filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (restricted(path)) return null
    const held = await holders(this.accessor, path)
    return machineFilesContaining(this.accessor, held, path, text, opts.ignoreCase)
  }

  override async write(
    path: PathSpec,
    data: ByteSource,
    _signal?: AbortSignal,
    _handed?: Handed,
    atomic = false,
  ): Promise<void> {
    await this.shown(path)
    await machineWrite(this.accessor, await lands(this.accessor, path), path, data, false, atomic)
  }

  override async append(path: PathSpec, data: ByteSource): Promise<void> {
    await this.shown(path)
    await machineWrite(this.accessor, await lands(this.accessor, path), path, data, true)
  }

  override async pwrite(path: PathSpec, data: Uint8Array, offset: number): Promise<void> {
    await this.shown(path)
    await machinePwrite(this.accessor, await lands(this.accessor, path), path, data, offset)
  }

  override async create(path: PathSpec): Promise<void> {
    await this.shown(path)
    await machineCreate(this.accessor, await lands(this.accessor, path), path)
  }

  override async truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    await this.shown(path)
    await machineTruncate(this.accessor, await lands(this.accessor, path), path, length, noCreate)
  }

  override async mkdir(path: PathSpec, parents = false): Promise<void> {
    await machineMkdir(this.accessor, await lands(this.accessor, path), path, parents)
  }

  override async unlink(path: PathSpec): Promise<void> {
    await machineUnlink(this.accessor, await holder(this.accessor, path), path)
  }

  override async rmdir(path: PathSpec): Promise<void> {
    for (const machine of await this.everywhere(path)) {
      await machineRmdir(this.accessor, machine, path)
    }
  }

  override async rmR(path: PathSpec): Promise<void> {
    for (const machine of await this.everywhere(path)) {
      await machineRmR(this.accessor, machine, path)
    }
  }

  override async rename(src: PathSpec, dst: PathSpec): Promise<void> {
    await this.shown(src, dst)
    const machine = await holder(this.accessor, src)
    const several = this.accessor.names().length > 1
    const held = several ? await holders(this.accessor, dst) : []
    const others = held.filter((m) => m !== machine)
    let folder = false
    if (others.length > 0) {
      folder = (await machineStat(this.accessor, machine, src)).type === FileType.DIRECTORY
      for (const other of others) {
        const there = await machineStat(this.accessor, other, dst)
        if ((there.type === FileType.DIRECTORY) !== folder)
          throw folder ? enotdir(dst) : eisdir(dst)
        if (folder && (await machineReaddir(this.accessor, [other], dst)).length > 0)
          throw enotempty(dst)
      }
    }
    const parents = several ? await holders(this.accessor, dst.dir) : []
    await machineRename(
      this.accessor,
      machine,
      src,
      dst,
      parents.length > 0 && !parents.includes(machine),
    )
    for (const other of others) {
      if (folder) await machineRmdir(this.accessor, other, dst)
      else await machineUnlink(this.accessor, other, dst)
    }
  }

  override async copy(src: PathSpec, dst: PathSpec): Promise<void> {
    await this.shown(src, dst)
    await machineCopy(this.accessor, await this.sameMachine(src, dst), src, dst)
  }

  override async dirCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    await this.shown(src, dst)
    await machineDirCopy(this.accessor, await this.sameMachine(src, dst), src, dst)
  }

  override async setattr(
    path: PathSpec,
    fields: SetAttrFields,
  ): Promise<Record<string, number | string>> {
    await this.shown(path)
    return machineSetAttrs(this.accessor, await holder(this.accessor, path), path, fields)
  }

  override capacity(): Promise<CapacityResult> {
    return machineCapacity(this.accessor, PathSpec.fromStrPath(this.config.root ?? '/'))
  }

  override storageLocation(): string {
    // The machines and the root pin the files, so two mounts of one tree
    // are known to share them.
    const machines = (this.config.machines ?? ['*']).join(',')
    return `${this.name}:${machines}:${rstripSlash(this.config.root ?? '/') || '/'}`
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  override async getState(): Promise<ConfigState<RedactedSchema<typeof MachineVFSConfig>>> {
    return this.configState(MachineVFSConfig, this.config)
  }

  /** The machines holding a directory, every one of which a removal reaches. */
  /**
   * Refuse a path the machine's own links lead to a name the session hides,
   * as the hide itself answers: no such file. Mirrors Python's `_shown`.
   *
   * @param paths the paths an op names.
   */
  private async shown(...paths: PathSpec[]): Promise<void> {
    for (const path of paths) if (await leadsToHidden(this.accessor, path)) throw enoent(path)
  }

  private async everywhere(path: PathSpec): Promise<string[]> {
    const held = await holders(this.accessor, path)
    if (held.length === 0) throw enoent(path)
    return held
  }

  /**
   * The machine a copy runs on: the source's, when the copy lands there
   * too; EXDEV otherwise, so the bytes move through Mirage as between two
   * mounts.
   */
  private async sameMachine(src: PathSpec, dst: PathSpec): Promise<string> {
    const machine = await holder(this.accessor, src)
    if ((await lands(this.accessor, dst)) !== machine) throw exdev(dst)
    return machine
  }
}
