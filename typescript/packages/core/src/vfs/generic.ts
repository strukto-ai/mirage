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

import type { Accessor } from '../accessor/base.ts'
import type { IndexConfig } from '../cache/index/config.ts'
import { type CommandIO, makeGenericCommands } from '../commands/builtin/generic_bind/index.ts'

import type { ProvisionFn, RegisteredCommand } from '../commands/config.ts'
import { makeGenericOps } from '../ops/generic/factory.ts'
import type { RegisteredOp } from '../ops/registry.ts'

import { type VFS, type VFSStateBase } from './base.ts'
import type { VFSAdapter } from './adapter.ts'
import { BoundVFS } from './bound.ts'

export interface GenericVFSOptions<A extends Accessor = Accessor> {
  /**
   * VFS name the commands and ops register under, and the `type`
   * key `getState` writes into a snapshot. Also the registry key when
   * the backend is exposed through `registerVfsFactory`.
   */
  name: string
  /** Backend handle passed to every core fn on the table. */
  accessor: A
  /** Resource capabilities or a prebuilt command/dispatcher table. */
  io: CommandIO<A> | VFSAdapter<A>
  /** LLM-facing description of the mounted layout. */
  prompt?: string
  /** Appended to `prompt` when the mount is writable. */
  writePrompt?: string
  /**
   * Generic command names the backend replaces. Pass the replacements
   * through `commands`.
   */
  overrides?: ReadonlySet<string>
  /**
   * Extra commands, from `command({...})`: bespoke verbs, or the
   * replacements for whatever `overrides` suppressed.
   */
  commands?: readonly RegisteredCommand[]
  /**
   * Irregular VFS/FUSE handlers, layered over the auto-derived set. One
   * carrying no filetype shadows the derived op of the same name.
   *
   * Plain records rather than Python's decorated functions: TypeScript's
   * `op` is a *method* decorator, so a standalone handler has no
   * decorator form to carry its registration.
   */
  ops?: readonly RegisteredOp[]
  /** Per-command cost estimators replacing the catalog default. */
  provisionOverrides?: Record<string, ProvisionFn<A>>
  /**
   * Derive the VFS/FUSE op set from the table (read/readdir/stat plus
   * whatever mutations the table carries). Set false to register only
   * the explicit `ops`.
   */
  autoOps?: boolean
  /** Serve repeat reads from the file cache. Read-mostly content only. */
  cachesReads?: boolean
  /**
   * Whether `io.stat` sizes every regular file without fetching it. A
   * backend that renders its content on read leaves this false and rides
   * the unknown-size machinery; a byte store sets it, which is also what
   * makes the mount legal on FSKit.
   */
  sizesAlwaysKnown?: boolean
  /**
   * Whether `io.stat` fills `FileStat.fingerprint` with a stable
   * per-path version marker. Setting it without that is not drift
   * detection, it is a snapshot that claims to have one.
   */
  supportsSnapshot?: boolean
  /**
   * Whether `io.stat` and the read record stamp the *same kind* of content
   * token, so a `read: fresh` mount can compare them. Setting it without
   * that makes every read verdict stale and refetch forever; a mount
   * declaring `fresh` on a backend that leaves it false is refused at mount
   * time instead.
   */
  readRevalidatable?: boolean
  /** Cache-index configuration. Omitted leaves the lazy RAM default. */
  index?: IndexConfig
}

/**
 * A whole backend generated from resource capabilities or a CommandIO table.
 *
 * The one-file path for a custom backend: supply an accessor and the
 * three core functions on a VFSAdapter (readdir/readBytes/stat), and the
 * generic commands, glob resolution and VFS/FUSE ops arrive wired.
 * Optional fields on the table unlock more surface (`write` enables the
 * byte-mutation family's writes, `find` and `du` become native fast
 * paths). A table without an op still gets every command: `gzip -c` and
 * `tar -t` run as readers, and a line that needs the missing op answers
 * ENOTSUP at that op.
 *
 * The escape hatches are the ones the builtins use, because this class
 * assembles exactly what they assemble by hand: `overrides` drops a
 * generic command, `commands` appends a bespoke verb, `ops` layers an
 * irregular handler over the derived set.
 *
 * Mirrors Python `mirage.vfs.generic.GenericVFS`. The accessor
 * generic is the one thing it does not mirror: it type-checks the table
 * against the accessor the core fns actually take, which Python leaves
 * as `Any` for contravariance reasons documented on its own op
 * protocols.
 */
export class GenericVFS<A extends Accessor = Accessor> extends BoundVFS<A> implements VFS {
  readonly kind: string
  readonly accessor: A
  readonly prompt: string
  readonly writePrompt: string
  readonly cachesReads: boolean
  readonly sizesAlwaysKnown: boolean
  readonly supportsSnapshot: boolean
  readonly readRevalidatable: boolean
  readonly #commands: readonly RegisteredCommand[]
  readonly #ops: readonly RegisteredOp[]

  constructor(options: GenericVFSOptions<A>) {
    super(options.io)
    if (options.name === '') throw new Error('GenericVFS requires a non-empty name')
    this.kind = options.name
    this.accessor = options.accessor
    const io = this.io
    this.prompt = options.prompt ?? ''
    this.writePrompt = options.writePrompt ?? ''
    this.cachesReads = options.cachesReads ?? false
    this.sizesAlwaysKnown = options.sizesAlwaysKnown ?? false
    this.supportsSnapshot = options.supportsSnapshot ?? false
    this.readRevalidatable = options.readRevalidatable ?? false
    if (options.index !== undefined) this.setIndex(options.index)
    this.#commands = [
      ...makeGenericCommands<A>(options.name, io, {
        ...(options.overrides !== undefined ? { overrides: options.overrides } : {}),
        ...(options.provisionOverrides !== undefined
          ? { provisionOverrides: options.provisionOverrides }
          : {}),
      }),
      ...(options.commands ?? []),
    ]
    const userOps = options.ops ?? []
    // A user op carrying no filetype replaces the derived op of the same
    // name: the derived set is built with those names skipped, so
    // registering both cannot leave two handlers competing for one key.
    const shadowed = new Set(userOps.filter((ro) => ro.filetype === null).map((ro) => ro.name))
    const derived =
      options.autoOps === false ? [] : makeGenericOps<A>(options.name, io, { overrides: shadowed })
    this.#ops = [...derived, ...userOps]
  }

  // The base cannot know a subclass's constructor, so by default a
  // GenericVFS cannot be rebuilt from its state and says so: both
  // loaders then require the mount to be handed back live (`load`'s
  // overrides; `copy()` does this itself). A subclass whose content is
  // its own, the way RAMVFS's is, overrides this and `loadState` to
  // carry that content and drops the flag; registered under its name it
  // rebuilds from a snapshot or a version with no override, and its
  // content is what gets versioned. A subclass over a remote backend
  // keeps the flag and versions through `supportsSnapshot` fingerprints
  // instead: that content is the backend's, and a snapshot only pins
  // what it observed.
  override getState(): VFSStateBase {
    return { type: this.kind, needs_override: true }
  }

  commands(): readonly RegisteredCommand[] {
    return this.#commands
  }

  ops(): readonly RegisteredOp[] {
    return this.#ops
  }
}
