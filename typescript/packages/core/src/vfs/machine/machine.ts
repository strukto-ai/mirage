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
import {
  chosen,
  commandMachine,
  holder,
  holders,
  kernelView,
  writeMachine,
} from '../../core/machine/place.ts'
import { pwrite as machinePwrite } from '../../core/machine/pwrite.ts'
import {
  firstLines as machineFirstLines,
  lastLines as machineLastLines,
  lineCount as machineLineCount,
  read as machineRead,
} from '../../core/machine/read.ts'
import { readdir as machineReaddir, tree as machineTree } from '../../core/machine/readdir.ts'
import { rename as machineRename } from '../../core/machine/rename.ts'
import { rmR as machineRmR } from '../../core/machine/rm.ts'
import { rmdir as machineRmdir } from '../../core/machine/rmdir.ts'
import { filesContaining as machineFilesContaining } from '../../core/machine/search.ts'
import { setAttrs as machineSetAttrs } from '../../core/machine/set_attrs.ts'
import {
  entryStat,
  hiddenOn,
  leaf,
  restricted,
  stat as machineStat,
} from '../../core/machine/stat.ts'
import { truncate as machineTruncate } from '../../core/machine/truncate.ts'
import type { Holder } from '../../core/machine/types.ts'
import { unlink as machineUnlink } from '../../core/machine/unlink.ts'
import { folderOf } from '../../core/machine/utils.ts'
import { write as machineWrite } from '../../core/machine/write.ts'
import { eisdir, enoent, enotdir, enotempty, enotsup } from '../../errors/fs.ts'
import type { MachineTable } from '../../execution/machine/table.ts'
import type { ByteSource } from '../../io/types.ts'
import {
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
 * Over several machines the mount shows one tree, as one machine would hold
 * it. A name several machines hold is the copy written last, for every look
 * at it and every change to it; a removal or a rename takes the name off
 * every machine; a new name lands where its folder is, on the machine the
 * command is about when that machine holds the folder; and a directory
 * lists every machine's entries once. No file is copied between machines to
 * keep them alike: a program opens its own machine's disk, whatever another
 * machine holds. `"@<machine>"` in a mount table is this VFS over that
 * machine at the same path, so Mirage and the machine's programs name a
 * file the same way. Mirrors Python's `MachineVFS`.
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
    const hidden = await hiddenOn(this.accessor, path)
    const own = kernelView(this.accessor, path)
    const machines = this.accessor
      .names()
      .filter((m) => !hidden.includes(m) && (own === null || own === m))
    if (machines.length === 0) throw enoent(path)
    return machineReaddir(this.accessor, machines, path)
  }

  override actsOn(): string | null {
    if (!this.accessor.bound) return null
    const names = this.accessor.names()
    const [only] = names
    if (names.length === 1 && only !== undefined) return only
    return commandMachine(this.accessor)
  }

  override filesystem(): string {
    if (!this.accessor.bound) return this.name
    const machine = this.actsOn() ?? this.accessor.defaultMachine
    return `${machine}:${rstripSlash(this.config.root ?? '/') || '/'}`
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    const held = await holders(this.accessor, path)
    if (held.length === 0) throw enoent(path)
    const one = chosen(this.accessor, held)
    if (one.entry === null) return machineStat(this.accessor, one.machine, path)
    return entryStat(leaf(path), one.entry)
  }

  override async read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> {
    return machineRead(this.accessor, await holder(this.accessor, path), path, offset, size)
  }

  override async firstLines(path: PathSpec, n: number): Promise<Uint8Array | null> {
    return machineFirstLines(this.accessor, await holder(this.accessor, path), path, n)
  }

  override async lastLines(path: PathSpec, n: number): Promise<Uint8Array | null> {
    return machineLastLines(this.accessor, await holder(this.accessor, path), path, n)
  }

  override async lineCount(path: PathSpec): Promise<number | null> {
    return machineLineCount(this.accessor, await holder(this.accessor, path), path)
  }

  override async checksum(path: PathSpec, algorithm: string): Promise<string | null> {
    return machineChecksum(this.accessor, await holder(this.accessor, path), path, algorithm)
  }

  override async readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    if (restricted(path)) return null
    const held = await this.everywhere(path)
    return machineTree(
      this.accessor,
      held.map((one) => one.machine),
      path,
    )
  }

  override async filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (restricted(path)) return null
    const held = await holders(this.accessor, path)
    return machineFilesContaining(
      this.accessor,
      held.map((one) => one.machine),
      path,
      text,
      opts.ignoreCase,
    )
  }

  override async write(
    path: PathSpec,
    data: ByteSource,
    _signal?: AbortSignal,
    _handed?: Handed,
    atomic = false,
  ): Promise<void> {
    const machine = await writeMachine(this.accessor, path, { replaces: true })
    await machineWrite(this.accessor, machine, path, data, false, atomic)
  }

  override async append(path: PathSpec, data: ByteSource): Promise<void> {
    await machineWrite(this.accessor, await writeMachine(this.accessor, path), path, data, true)
  }

  override async pwrite(path: PathSpec, data: Uint8Array, offset: number): Promise<void> {
    await machinePwrite(this.accessor, await writeMachine(this.accessor, path), path, data, offset)
  }

  override async create(path: PathSpec): Promise<void> {
    await machineCreate(this.accessor, await writeMachine(this.accessor, path), path)
  }

  override async truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    const machine = await writeMachine(this.accessor, path)
    await machineTruncate(this.accessor, machine, path, length, noCreate)
  }

  override async mkdir(path: PathSpec, parents = false): Promise<void> {
    const machine = await writeMachine(this.accessor, path, { parents })
    await machineMkdir(this.accessor, machine, path, parents)
  }

  override async unlink(path: PathSpec): Promise<void> {
    // Every machine's copy goes, or an older one would show again; a folder
    // another machine holds at the name is left alone.
    const held = await this.everywhere(path)
    const shown = chosen(this.accessor, held)
    await machineUnlink(this.accessor, shown.machine, path)
    for (const one of held) {
      if (one !== shown && !one.folder) await machineUnlink(this.accessor, one.machine, path)
    }
  }

  override async rmdir(path: PathSpec): Promise<void> {
    const held = await this.everywhere(path)
    const shown = chosen(this.accessor, held)
    const folders = held.filter((one) => one.folder).map((one) => one.machine)
    // Asked of every machine before any removes its copy, so a folder one
    // of them still fills is left whole on all of them.
    if (
      shown.folder &&
      folders.length > 1 &&
      (await machineReaddir(this.accessor, folders, path)).length > 0
    )
      throw enotempty(path)
    await machineRmdir(this.accessor, shown.machine, path)
    for (const one of held) {
      if (one !== shown && one.folder) await machineRmdir(this.accessor, one.machine, path)
    }
  }

  override async rmR(path: PathSpec): Promise<void> {
    for (const one of await this.everywhere(path)) {
      await machineRmR(this.accessor, one.machine, path)
    }
  }

  override async rename(src: PathSpec, dst: PathSpec): Promise<void> {
    const held = await this.everywhere(src)
    const moved = chosen(this.accessor, held)
    const folder = moved.folder
    // A folder is renamed on every machine holding it, each keeping its own
    // entries; a file on the machine whose copy it is, the other machines'
    // copies of the old name going with it.
    const movers = folder
      ? held.filter((one) => one.folder).map((one) => one.machine)
      : [moved.machine]
    const several = this.accessor.names().length > 1
    const there = several ? await holders(this.accessor, dst) : []
    const replaced = there.filter((one) => !movers.includes(one.machine))
    // Every machine's copy of the new name is judged before any machine
    // moves, so a refusal leaves the folder under one name.
    for (const one of there) {
      if (one.folder !== folder) throw folder ? enotdir(dst) : eisdir(dst)
      if (folder && (await machineReaddir(this.accessor, [one.machine], dst)).length > 0)
        throw enotempty(dst)
    }
    const parents = several
      ? (await holders(this.accessor, folderOf(dst))).map((one) => one.machine)
      : []
    for (const machine of movers) {
      await machineRename(
        this.accessor,
        machine,
        src,
        dst,
        parents.length > 0 && !parents.includes(machine),
      )
    }
    for (const one of replaced) {
      if (folder) await machineRmdir(this.accessor, one.machine, dst)
      else await machineUnlink(this.accessor, one.machine, dst)
    }
    for (const one of held) {
      if (!movers.includes(one.machine) && !one.folder)
        await machineUnlink(this.accessor, one.machine, src)
    }
  }

  override async copy(src: PathSpec, dst: PathSpec): Promise<void> {
    // A copy never crosses: it is made where the source is, and is then the
    // newest copy of its name.
    const machine = await holder(this.accessor, src)
    await this.refuseHidden(machine, dst)
    await machineCopy(this.accessor, machine, src, dst, await this.lacksFolder(machine, dst))
    if (this.accessor.names().length === 1) return
    // The copy replaces the name, so another machine's copy of it goes: one
    // kept would show again once the new copy takes its source's older
    // time (`cp -p`).
    for (const one of await holders(this.accessor, dst)) {
      if (one.machine !== machine && !one.folder)
        await machineUnlink(this.accessor, one.machine, dst)
    }
  }

  override async dirCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    const held = await this.everywhere(src)
    const [only] = held
    // Each name under a folder several machines hold is copied where it is,
    // one by one, so each stays the copy it was.
    if (held.length > 1 || only === undefined) throw enotsup(this.name, 'dir_copy', src)
    await this.refuseHidden(only.machine, dst)
    await machineDirCopy(
      this.accessor,
      only.machine,
      src,
      dst,
      await this.lacksFolder(only.machine, dst),
    )
  }

  override async setattr(
    path: PathSpec,
    fields: SetAttrFields,
  ): Promise<Record<string, number | string>> {
    return machineSetAttrs(this.accessor, await holder(this.accessor, path), path, fields)
  }

  override capacity(): Promise<CapacityResult> {
    return machineCapacity(
      this.accessor,
      this.actsOn() ?? this.accessor.defaultMachine,
      PathSpec.fromStrPath(this.config.root ?? '/'),
    )
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

  /**
   * The machines holding a name, every one of which a removal or a rename
   * reaches.
   *
   * @param path the name.
   * @throws ENOENT when no machine holds it.
   */
  private async everywhere(path: PathSpec): Promise<Holder[]> {
    const held = await holders(this.accessor, path)
    if (held.length === 0) throw enoent(path)
    return held
  }

  /**
   * Refuse a name a machine's own links lead to one the session hides,
   * before a program of the machine's writes through them.
   *
   * @param machine the machine the write runs on.
   * @param path the name written.
   * @throws ENOENT when the name leads to a hidden one there.
   */
  private async refuseHidden(machine: string, path: PathSpec): Promise<void> {
    if ((await hiddenOn(this.accessor, path)).includes(machine)) throw enoent(path)
  }

  /**
   * Whether a new name's folder is on other machines only, so the machine
   * the name lands on makes the folder first.
   *
   * @param machine the machine the name lands on.
   * @param path the new name.
   */
  private async lacksFolder(machine: string, path: PathSpec): Promise<boolean> {
    if (this.accessor.names().length === 1) return false
    const folders = (await holders(this.accessor, folderOf(path)))
      .filter((one) => one.folder)
      .map((one) => one.machine)
    return folders.length > 0 && !folders.includes(machine)
  }
}
