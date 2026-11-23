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
import {
  copy as machineCopy,
  copyFrom as machineCopyFrom,
  dirCopy as machineDirCopy,
} from '../../core/machine/copy.ts'
import { create as machineCreate } from '../../core/machine/create.ts'
import { mkdir as machineMkdir } from '../../core/machine/mkdir.ts'
import {
  askedMachines,
  chosen,
  commandMachine,
  crossingRefused,
  existingHolders,
  holders,
  holdingMachine,
  machinesLackingFolder,
  refuseCrossing,
  refuseHidden,
  writeMachine,
} from '../../core/machine/place.ts'
import { pwrite as machinePwrite } from '../../core/machine/pwrite.ts'
import {
  firstLines as machineFirstLines,
  lastLines as machineLastLines,
  lineCount as machineLineCount,
  read as machineRead,
  readStream as machineReadStream,
} from '../../core/machine/read.ts'
import { readdir as machineReaddir, tree as machineTree } from '../../core/machine/readdir.ts'
import { rename as machineRename } from '../../core/machine/rename.ts'
import { rmR as machineRmR } from '../../core/machine/rm.ts'
import { rmdir as machineRmdir } from '../../core/machine/rmdir.ts'
import { filesContaining as machineFilesContaining } from '../../core/machine/search.ts'
import { setAttrs as machineSetAttrs } from '../../core/machine/set_attrs.ts'
import { hasHides, holderStat, stat as machineStat } from '../../core/machine/stat.ts'
import { truncate as machineTruncate } from '../../core/machine/truncate.ts'
import { unlink as machineUnlink } from '../../core/machine/unlink.ts'
import { leaf } from '../../core/machine/utils.ts'
import { write as machineWrite } from '../../core/machine/write.ts'
import { eisdir, enoent, enotdir, enotempty, enotsup, exdev } from '../../errors/fs.ts'
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
    const machines = await askedMachines(this.accessor, path)
    if (machines.length === 0) throw enoent(path)
    return machineReaddir(this.accessor, machines, path)
  }

  override callMachine(): string | null {
    if (!this.accessor.bound) return null
    if (!this.accessor.several) return this.accessor.defaultMachine
    return commandMachine(this.accessor)
  }

  override filesystem(): string {
    if (!this.accessor.bound) return this.name
    const machine = this.callMachine() ?? this.accessor.defaultMachine
    return `${machine}:${rstripSlash(this.config.root ?? '/') || '/'}`
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    const one = chosen(this.accessor, await existingHolders(this.accessor, path))
    if (one.entry === null) return machineStat(this.accessor, one.machine, path)
    return holderStat(leaf(path), one)
  }

  /**
   * A file's bytes from the machine holding it; a whole file as a stream,
   * never held whole, where the machine's output can be read as it comes. A
   * program the line runs on another machine never reads it
   * (`refuseCrossing`).
   *
   * @param path the file.
   * @param _handed unused.
   * @param offset the first byte.
   * @param size how many bytes; null for the rest.
   */
  override async read(
    path: PathSpec,
    _handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> {
    const machine = await holdingMachine(this.accessor, path)
    refuseCrossing(this.accessor, machine, path, true)
    if (offset === 0 && size === null && this.accessor.streams(machine))
      return machineReadStream(this.accessor, machine, path)
    return machineRead(this.accessor, machine, path, offset, size)
  }

  override async firstLines(path: PathSpec, n: number): Promise<Uint8Array | null> {
    return machineFirstLines(this.accessor, await holdingMachine(this.accessor, path), path, n)
  }

  override async lastLines(path: PathSpec, n: number): Promise<Uint8Array | null> {
    return machineLastLines(this.accessor, await holdingMachine(this.accessor, path), path, n)
  }

  override async lineCount(path: PathSpec): Promise<number | null> {
    return machineLineCount(this.accessor, await holdingMachine(this.accessor, path), path)
  }

  override async checksum(path: PathSpec, algorithm: string): Promise<string | null> {
    return machineChecksum(
      this.accessor,
      await holdingMachine(this.accessor, path),
      path,
      algorithm,
    )
  }

  override async readTree(path: PathSpec): Promise<Map<string, FileStat> | null> {
    if (hasHides(path)) return null
    const held = await existingHolders(this.accessor, path)
    const shown = await machineTree(
      this.accessor,
      held.map((one) => one.machine),
      path,
    )
    if (shown === null) return null
    const stats = new Map<string, FileStat>()
    for (const [rel, one] of shown) stats.set(rel, holderStat(rel.split('/').pop() ?? rel, one))
    return stats
  }

  override async filesContaining(
    path: PathSpec,
    text: string,
    opts: { wholeWord: boolean; ignoreCase: boolean },
  ): Promise<PathSpec[] | null> {
    if (hasHides(path)) return null
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
    refuseCrossing(this.accessor, machine, path)
    await machineWrite(this.accessor, machine, path, data, false, atomic)
  }

  override async append(path: PathSpec, data: ByteSource): Promise<void> {
    const machine = await writeMachine(this.accessor, path)
    refuseCrossing(this.accessor, machine, path)
    await machineWrite(this.accessor, machine, path, data, true)
  }

  override async pwrite(path: PathSpec, data: Uint8Array, offset: number): Promise<void> {
    const machine = await writeMachine(this.accessor, path)
    refuseCrossing(this.accessor, machine, path)
    await machinePwrite(this.accessor, machine, path, data, offset)
  }

  override async create(path: PathSpec): Promise<void> {
    const machine = await writeMachine(this.accessor, path)
    refuseCrossing(this.accessor, machine, path)
    await machineCreate(this.accessor, machine, path)
  }

  override async truncate(path: PathSpec, length: number, noCreate = false): Promise<void> {
    const machine = await writeMachine(this.accessor, path)
    refuseCrossing(this.accessor, machine, path)
    await machineTruncate(this.accessor, machine, path, length, noCreate)
  }

  override async mkdir(path: PathSpec, parents = false): Promise<void> {
    const machine = await writeMachine(this.accessor, path, { parents })
    await machineMkdir(this.accessor, machine, path, parents)
  }

  /**
   * Remove a file from every machine holding it, or an older copy would
   * show again; a folder another machine holds at the name is left alone.
   *
   * @param path the file.
   */
  override async unlink(path: PathSpec): Promise<void> {
    const held = await existingHolders(this.accessor, path)
    const shown = chosen(this.accessor, held)
    await machineUnlink(this.accessor, shown.machine, path)
    for (const one of held) {
      if (one !== shown && !one.isFolder) await machineUnlink(this.accessor, one.machine, path)
    }
  }

  /**
   * Remove an empty folder from every machine holding it. Every machine is
   * asked before any removes its copy, so a folder one of them still fills
   * is left whole on all of them.
   *
   * @param path the folder.
   */
  override async rmdir(path: PathSpec): Promise<void> {
    const held = await existingHolders(this.accessor, path)
    const shown = chosen(this.accessor, held)
    const folders = held.filter((one) => one.isFolder).map((one) => one.machine)
    if (
      shown.isFolder &&
      folders.length > 1 &&
      (await machineReaddir(this.accessor, folders, path)).length > 0
    )
      throw enotempty(path)
    await machineRmdir(this.accessor, shown.machine, path)
    for (const one of held) {
      if (one !== shown && one.isFolder) await machineRmdir(this.accessor, one.machine, path)
    }
  }

  override async rmR(path: PathSpec): Promise<void> {
    for (const one of await existingHolders(this.accessor, path)) {
      await machineRmR(this.accessor, one.machine, path)
    }
  }

  /**
   * Rename a name where it is. A folder is renamed on every machine holding
   * it, each keeping its own entries; a file on the machine whose copy is
   * shown, the other machines' copies of the old name going with it. Every
   * machine's copy of the new name is judged before any machine moves, so a
   * refusal leaves the folder under one name.
   *
   * @param src the name as it is.
   * @param dst the new name.
   */
  override async rename(src: PathSpec, dst: PathSpec): Promise<void> {
    const held = await existingHolders(this.accessor, src)
    const moved = chosen(this.accessor, held)
    const folder = moved.isFolder
    const movers = folder
      ? held.filter((one) => one.isFolder).map((one) => one.machine)
      : [moved.machine]
    const several = this.accessor.several
    const there = several ? await holders(this.accessor, dst) : []
    const replaced = there.filter((one) => !movers.includes(one.machine))
    for (const one of there) {
      if (one.isFolder !== folder) throw folder ? enotdir(dst) : eisdir(dst)
      if (folder && (await machineReaddir(this.accessor, [one.machine], dst)).length > 0)
        throw enotempty(dst)
    }
    const lacking = await machinesLackingFolder(this.accessor, movers, dst)
    for (const machine of movers) {
      await machineRename(this.accessor, machine, src, dst, lacking.includes(machine))
    }
    for (const one of replaced) {
      if (folder) await machineRmdir(this.accessor, one.machine, dst)
      else await machineUnlink(this.accessor, one.machine, dst)
    }
    for (const one of held) {
      if (!movers.includes(one.machine) && !one.isFolder)
        await machineUnlink(this.accessor, one.machine, src)
    }
  }

  /**
   * Copy a file on the machine holding it: a copy never crosses, and is
   * then the newest copy of its name. It replaces the name, so another
   * machine's copy of it goes: one kept would show again once the new copy
   * takes its source's older time (`cp -p`).
   *
   * @param src the file.
   * @param dst the copy's name.
   */
  override async copy(src: PathSpec, dst: PathSpec): Promise<void> {
    const machine = await holdingMachine(this.accessor, src)
    await refuseHidden(this.accessor, machine, dst)
    const lacking = await machinesLackingFolder(this.accessor, [machine], dst)
    await machineCopy(this.accessor, machine, src, dst, lacking.length > 0)
    if (!this.accessor.several) return
    for (const one of await holders(this.accessor, dst)) {
      if (one.machine !== machine && !one.isFolder)
        await machineUnlink(this.accessor, one.machine, dst)
    }
  }

  /**
   * Copy a file another machine mount shows, on the machine holding it, when
   * this mount shows that machine too: the copy lands where its source is
   * and its bytes never leave the machine (`cp /srv/a/out /tmp/out`),
   * replacing the name as `copy` does. A file of a machine this mount does
   * not show is refused: bytes go between a machine and a store, never from
   * one machine to another. A store's file is EXDEV, and its bytes come
   * through Mirage.
   *
   * @param source the source mount's VFS.
   * @param src the file, on `source`.
   * @param dst the copy, on this mount.
   * @throws FsError EXDEV for a source that is no machine's file; EACCES
   *   for a source on a machine this mount does not show.
   */
  override async copyFrom(source: BaseVFS, src: PathSpec, dst: PathSpec): Promise<void> {
    if (!(source instanceof MachineVFS)) throw exdev(dst)
    const machine = await holdingMachine(source.accessor, src)
    if (!this.accessor.names().includes(machine)) {
      const target = await writeMachine(this.accessor, dst, { replaces: true })
      throw crossingRefused(machine, target, dst)
    }
    await refuseHidden(this.accessor, machine, dst)
    const lacking = await machinesLackingFolder(this.accessor, [machine], dst)
    await machineCopyFrom(source.accessor, this.accessor, machine, src, dst, lacking.length > 0)
    if (!this.accessor.several) return
    for (const one of await holders(this.accessor, dst)) {
      if (one.machine !== machine && !one.isFolder)
        await machineUnlink(this.accessor, one.machine, dst)
    }
  }

  /**
   * Copy a folder one machine holds, on that machine. A folder several
   * machines hold is refused, so each name under it is copied where it is,
   * one by one, and stays the copy it was.
   *
   * @param src the folder.
   * @param dst the copy's name.
   */
  override async dirCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    const held = await existingHolders(this.accessor, src)
    const [only] = held
    if (held.length > 1 || only === undefined) throw enotsup(this.name, 'dir_copy', src)
    await refuseHidden(this.accessor, only.machine, dst)
    const lacking = await machinesLackingFolder(this.accessor, [only.machine], dst)
    await machineDirCopy(this.accessor, only.machine, src, dst, lacking.length > 0)
  }

  override async setattr(
    path: PathSpec,
    fields: SetAttrFields,
  ): Promise<Record<string, number | string>> {
    return machineSetAttrs(this.accessor, await holdingMachine(this.accessor, path), path, fields)
  }

  override capacity(): Promise<CapacityResult> {
    return machineCapacity(
      this.accessor,
      this.callMachine() ?? this.accessor.defaultMachine,
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
}
