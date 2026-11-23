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

import type { PipeWriter } from '../runtime/types.ts'

/**
 * How a machine sees the workspace: `ssh` serves every prefix from the
 * host over SFTP, `fuse` leaves them to the machine's own mirage, and
 * `both` serves from the host what the machine does not mount itself.
 */
/**
 * What a run's pid line says (`RUN_WRAPPER`): its program's pid and start in
 * clock ticks, null when the line gives none. Mirrors Python's `RunStatus`.
 */
export interface RunStatus {
  readonly pid: number
  readonly started: number | null
}

/**
 * Who serves the workspace's files to a machine: the host through sshfs
 * (`ssh`) or mirage-fuse (`mirage`), the machine's own Mirage (`own`), or
 * the machine's own mounts where it has them and mirage-fuse for the rest
 * (`both`).
 */
export type MountType = 'ssh' | 'mirage' | 'own' | 'both'

/** How the host serves a machine the prefixes it serves. */
export type Transport = 'ssh' | 'mirage'

/** What a provider does to its machine when the workspace pauses. */
export type PauseAction = 'pause'

/**
 * Where a workspace keeps the machines Mirage started for it, each its
 * provider's id by the machine's name, so a later build of the workspace
 * reaches the one it started instead of starting another. Mirrors Python's
 * `MachineMemory`.
 */
export interface MachineMemory {
  /** The workspace's id, which names the mounts it serves into a machine (`sourceName`). */
  readonly workspaceId: string
  /** The machine Mirage started for `name`; null when it started none. */
  recall(name: string): Promise<string | null>
  /** Keep `instance` as the machine Mirage started for `name`. */
  remember(name: string, instance: string): Promise<void>
  /** Drop the machine kept for `name`, once it is gone. */
  forget(name: string): Promise<void>
  /** Every machine kept, its provider's id by the machine's name. */
  remembered(): Promise<Record<string, string>>
}

/** A command a machine runs with its stdin and stdout held open. */
export interface MachinePipe {
  /** What the command writes. */
  readonly reader: ReadableStream<Uint8Array>
  /** What the command reads. */
  readonly writer: PipeWriter
  /** Ends the command. */
  stop(): Promise<void>
  /** Bounded startup diagnostics, when available. */
  diagnostic?(): Promise<string>
}

/**
 * What turns a scan's raw figures into usage: seconds since boot, clock ticks
 * a second, the page size in bytes and the memory in KiB. Mirrors Python's
 * `ScanFacts`.
 */
export interface ScanFacts {
  readonly upSeconds: number
  readonly ticks: number
  readonly page: number
  readonly memory: number
}
