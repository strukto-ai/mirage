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
import {
  type CommandIO,
  type ResolveGlobOp,
  makeGenericCommands,
  resolveGlobOf,
} from '../commands/builtin/generic_bind/index.ts'
import type { ProvisionFn, RegisteredCommand } from '../commands/config.ts'
import { makeGenericOps } from '../ops/generic/factory.ts'
import type { RegisteredOp } from '../ops/registry.ts'
import type { FileStat, PathSpec } from '../types.ts'
import { BaseResource, type FindOptions, type Resource, type ResourceStateBase } from './base.ts'

export interface GenericResourceOptions<A extends Accessor = Accessor> {
  /**
   * Resource name the commands and ops register under, and the `type`
   * key `getState` writes into a snapshot. Also the registry key when
   * the backend is exposed through `registerResourceFactory`.
   */
  name: string
  /** Backend handle passed to every core fn on the table. */
  accessor: A
  /** The backend's IO table. */
  io: CommandIO<A>
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
  /** Cache-index configuration. Omitted leaves the lazy RAM default. */
  index?: IndexConfig
}

/**
 * A whole backend generated from one {@link CommandIO} table.
 *
 * The one-file path for a custom backend: supply an accessor and the
 * core functions on a table (readdir/readBytes/readStream/stat at
 * minimum) and the generic command set arrives wired, along with glob
 * resolution and the VFS/FUSE ops. Optional fields on the table unlock
 * more surface (`write` enables the byte-mutation family, `find` and
 * `du` become native fast paths), and a command whose requirements the
 * table cannot meet is never registered rather than registered and
 * broken.
 *
 * The escape hatches are the ones the builtins use, because this class
 * assembles exactly what they assemble by hand: `overrides` drops a
 * generic command, `commands` appends a bespoke verb, `ops` layers an
 * irregular handler over the derived set.
 *
 * Mirrors Python `mirage.resource.generic.GenericResource`. The accessor
 * generic is the one thing it does not mirror: it type-checks the table
 * against the accessor the core fns actually take, which Python leaves
 * as `Any` for contravariance reasons documented on its own op
 * protocols.
 */
export class GenericResource<A extends Accessor = Accessor>
  extends BaseResource
  implements Resource
{
  readonly kind: string
  readonly accessor: A
  readonly io: CommandIO<A>
  readonly prompt: string
  readonly writePrompt: string
  readonly cachesReads: boolean
  readonly sizesAlwaysKnown: boolean
  readonly supportsSnapshot: boolean
  readonly #commands: readonly RegisteredCommand[]
  readonly #ops: readonly RegisteredOp[]
  readonly #glob: ResolveGlobOp<A>

  // The optional surface, declared but not defined. `declare` emits no
  // property, so a field the table does not carry stays genuinely absent
  // and `typeof r.writeFile === 'function'` answers truthfully. The
  // constructor installs a forwarder for each field the table does carry,
  // which is what Python's `_ops` map does through `__getattr__`.
  declare writeFile?: (path: PathSpec, data: Uint8Array) => Promise<void>
  declare appendFile?: (path: PathSpec, data: Uint8Array) => Promise<void>
  declare exists?: (path: PathSpec) => Promise<boolean>
  declare mkdir?: (path: PathSpec, options?: { recursive?: boolean }) => Promise<void>
  declare rmdir?: (path: PathSpec) => Promise<void>
  declare unlink?: (path: PathSpec) => Promise<void>
  declare rename?: (src: PathSpec, dst: PathSpec) => Promise<void>
  declare truncate?: (path: PathSpec, length: number) => Promise<void>
  declare copy?: (src: PathSpec, dst: PathSpec) => Promise<void>
  declare rmR?: (path: PathSpec) => Promise<void>
  declare du?: (path: PathSpec) => Promise<number>
  declare find?: (path: PathSpec, options?: FindOptions) => Promise<string[]>

  constructor(options: GenericResourceOptions<A>) {
    super()
    if (options.name === '') throw new Error('GenericResource requires a non-empty name')
    this.kind = options.name
    this.accessor = options.accessor
    this.io = options.io
    this.prompt = options.prompt ?? ''
    this.writePrompt = options.writePrompt ?? ''
    this.cachesReads = options.cachesReads ?? false
    this.sizesAlwaysKnown = options.sizesAlwaysKnown ?? false
    this.supportsSnapshot = options.supportsSnapshot ?? false
    if (options.index !== undefined) this.setIndex(options.index)
    this.#glob = resolveGlobOf(options.io)
    this.#commands = [
      ...makeGenericCommands<A>(options.name, options.io, {
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
      options.autoOps === false
        ? []
        : makeGenericOps<A>(options.name, options.io, { overrides: shadowed })
    this.#ops = [...derived, ...userOps]
    this.#installOptional(options.io)
  }

  // Each forwarder reads `this.index` when called rather than capturing
  // it, because `setIndex` can replace it after construction.
  #installOptional(io: CommandIO<A>): void {
    const { write, append, exists, mkdir, rmdir, unlink } = io
    const { rename, truncate, copy, rmR, du, find } = io
    if (write !== undefined) this.writeFile = (p, d) => write(this.accessor, p, d)
    if (append !== undefined) this.appendFile = (p, d) => append(this.accessor, p, d)
    if (exists !== undefined) this.exists = (p) => exists(this.accessor, p)
    if (mkdir !== undefined) this.mkdir = (p, o) => mkdir(this.accessor, p, o?.recursive)
    if (rmdir !== undefined) this.rmdir = (p) => rmdir(this.accessor, p)
    if (unlink !== undefined) this.unlink = (p) => unlink(this.accessor, p)
    if (rename !== undefined) this.rename = (s, d) => rename(this.accessor, s, d)
    if (truncate !== undefined) this.truncate = (p, n) => truncate(this.accessor, p, n)
    if (copy !== undefined) this.copy = (s, d) => copy(this.accessor, s, d)
    if (rmR !== undefined) this.rmR = (p) => rmR(this.accessor, p)
    if (du !== undefined) this.du = (p) => du.size(this.accessor, p, this.index)
    if (find !== undefined) this.find = (p, o) => find(this.accessor, p, o ?? {})
  }

  open(): Promise<void> {
    return Promise.resolve()
  }

  // The base cannot know a subclass's constructor, so by default a
  // GenericResource cannot be rebuilt from its state and says so: both
  // loaders then require the mount to be handed back live (`load`'s
  // overrides; `copy()` does this itself). A subclass whose content is
  // its own, the way RAMResource's is, overrides this and `loadState` to
  // carry that content and drops the flag; registered under its name it
  // rebuilds from a snapshot or a version with no override, and its
  // content is what gets versioned. A subclass over a remote backend
  // keeps the flag and versions through `supportsSnapshot` fingerprints
  // instead: that content is the backend's, and a snapshot only pins
  // what it observed.
  override getState(): ResourceStateBase {
    return { type: this.kind, needs_override: true }
  }

  commands(): readonly RegisteredCommand[] {
    return this.#commands
  }

  ops(): readonly RegisteredOp[] {
    return this.#ops
  }

  glob(paths: readonly PathSpec[], _prefix = ''): Promise<PathSpec[]> {
    return this.#glob(this.accessor, paths, this.index)
  }

  // The four table fields every backend must supply, forwarded so a
  // GenericResource answers the direct calls builtin resources answer.
  // These are unconditional because the table cannot omit them; the rest
  // are installed per instance above. What stays banned either way is a
  // forwarder that throws for a field the backend never filled, which
  // would answer a feature probe with a lie.
  readFile(path: PathSpec): Promise<Uint8Array> {
    return this.io.readBytes(this.accessor, path, this.index)
  }

  readdir(path: PathSpec): Promise<string[]> {
    return this.io.readdir(this.accessor, path, this.index)
  }

  stat(path: PathSpec): Promise<FileStat> {
    return this.io.stat(this.accessor, path, this.index)
  }

  streamPath(path: PathSpec): AsyncIterable<Uint8Array> {
    return this.io.readStream(this.accessor, path, this.index)
  }
}
