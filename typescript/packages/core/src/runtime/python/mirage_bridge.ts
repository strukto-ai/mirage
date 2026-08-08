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

import { isMissingPath } from '../../utils/errors.ts'
import type { BridgeDispatchFn } from '../types.ts'

export interface MirageEntry {
  path: string
  size: number
  isDir: boolean
}

export interface FSLike {
  mkdirTree(path: string): void
  writeFile(path: string, bytes: Uint8Array): void
}

interface MirageStat {
  size: number
  isDir: boolean
  mtimeMs: number
}

/**
 * One guest mutation, recorded in the order the script performed it.
 * `write` and `append` carry their bytes because the drain runs after the
 * script returns, when MEMFS holds only the final state: an atomic-write
 * (write a temp file, rename it into place) would otherwise replay as a
 * read of a path the rename already moved.
 */
export type MirageMutation =
  | { readonly kind: 'write'; readonly path: string; readonly bytes: Uint8Array }
  | { readonly kind: 'append'; readonly path: string; readonly bytes: Uint8Array }
  | { readonly kind: 'mkdir'; readonly path: string }
  | { readonly kind: 'unlink'; readonly path: string }
  | { readonly kind: 'rmdir'; readonly path: string }
  | { readonly kind: 'rename'; readonly path: string; readonly dst: string }

export interface MirageBridge {
  fetch(path: string): Promise<Uint8Array>
  flush(path: string, bytes: Uint8Array): Promise<void>
  list(path: string): Promise<MirageEntry[]>
  stat(path: string): Promise<MirageStat>
  unlink(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  rename(src: string, dst: string): Promise<void>
  /**
   * Live view of the workspace mount prefixes (trailing-slash normalized).
   * The fs shim consults this on every intercepted call, so the mount
   * registry stays the single source of truth: nothing is pushed into the
   * interpreter when mounts are added or removed.
   */
  prefixes(): string[]
  /**
   * Record one guest mutation. Every mark is deliberately synchronous:
   * the guest's close(), os.mkdir() and os.rename() run inside sync WASM
   * frames where awaiting a bridge op needs JSPI stack switching, which
   * most engines do not enable. The guest records here and the runtime
   * replays after the script returns, where awaiting is free.
   *
   * Args:
   *   path: mount-prefixed path the mutation names.
   *   bytes: the whole file for a write, the new tail for an append.
   */
  markWrite(path: string, bytes: Uint8Array): void
  markAppend(path: string, bytes: Uint8Array): void
  markMkdir(path: string): void
  markUnlink(path: string): void
  markRmdir(path: string): void
  markRename(src: string, dst: string): void
  /** Drain the journal: every mutation in guest order, cleared. */
  takeMutations(): MirageMutation[]
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + tail.length)
  out.set(head, 0)
  out.set(tail, head.length)
  return out
}

export function createMirageBridge(
  dispatch: BridgeDispatchFn,
  listMounts: () => string[] = () => [],
): MirageBridge {
  const journal: MirageMutation[] = []
  return {
    prefixes() {
      return listMounts().map((p) => (p.endsWith('/') ? p : p + '/'))
    },
    markWrite(path, bytes) {
      // A guest buffer handed over by pyodide can be a view into WASM
      // memory, which relocates when the heap grows; copy on arrival so
      // the journal owns bytes that stay valid until the drain.
      const owned = new Uint8Array(bytes)
      const last = journal[journal.length - 1]
      if (last?.kind === 'write' && last.path === path) {
        journal[journal.length - 1] = { kind: 'write', path, bytes: owned }
        return
      }
      journal.push({ kind: 'write', path, bytes: owned })
    },
    markAppend(path, bytes) {
      const owned = new Uint8Array(bytes)
      const last = journal[journal.length - 1]
      if (last?.kind === 'append' && last.path === path) {
        journal[journal.length - 1] = {
          kind: 'append',
          path,
          bytes: concatBytes(last.bytes, owned),
        }
        return
      }
      journal.push({ kind: 'append', path, bytes: owned })
    },
    markMkdir(path) {
      journal.push({ kind: 'mkdir', path })
    },
    markUnlink(path) {
      journal.push({ kind: 'unlink', path })
    },
    markRmdir(path) {
      journal.push({ kind: 'rmdir', path })
    },
    markRename(src, dst) {
      journal.push({ kind: 'rename', path: src, dst })
    },
    takeMutations() {
      return journal.splice(0, journal.length)
    },
    async fetch(path) {
      const out = await dispatch('READ', path)
      if (!(out instanceof Uint8Array)) {
        throw new TypeError(`mirage bridge: READ ${path} expected Uint8Array, got ${typeof out}`)
      }
      return out
    },
    async flush(path, bytes) {
      const out = await dispatch('WRITE', path, bytes)
      if (out !== undefined) {
        throw new TypeError(`mirage bridge: WRITE ${path} expected void, got ${typeof out}`)
      }
    },
    async stat(path) {
      const out = await dispatch('STAT', path)
      const st = out as MirageStat | null
      if (
        st === null ||
        typeof st !== 'object' ||
        typeof st.size !== 'number' ||
        typeof st.isDir !== 'boolean' ||
        typeof st.mtimeMs !== 'number'
      ) {
        throw new TypeError(`mirage bridge: STAT ${path} bad shape`)
      }
      return st
    },
    async unlink(path) {
      await dispatch('UNLINK', path)
    },
    async mkdir(path) {
      await dispatch('MKDIR', path)
    },
    async rmdir(path) {
      await dispatch('RMDIR', path)
    },
    async rename(src, dst) {
      await dispatch('RENAME', src, undefined, dst)
    },
    async list(path) {
      const out = await dispatch('LIST', path)
      if (!Array.isArray(out)) {
        throw new TypeError(`mirage bridge: LIST ${path} expected array`)
      }
      for (const e of out) {
        if (
          e === null ||
          typeof e !== 'object' ||
          typeof (e as MirageEntry).path !== 'string' ||
          typeof (e as MirageEntry).size !== 'number' ||
          typeof (e as MirageEntry).isDir !== 'boolean'
        ) {
          throw new TypeError(`mirage bridge: LIST ${path} bad entry shape`)
        }
      }
      return out as MirageEntry[]
    },
  }
}

/**
 * Extend a mount file by `tail`.
 *
 * Read-modify-write, because no transport op appends yet: the whole file
 * goes back over the wire per call, which is why the append-amplification
 * conformance row stays marked. It also leaves the append non-atomic
 * against a concurrent writer, the same lost-update hazard whole-file
 * flushing already carries; a transport append op closes both at once.
 *
 * Only a confirmed absence starts from an empty base, since an append
 * may create the file. Every other read failure propagates: writing the
 * tail on its own over a file that exists but is momentarily unreadable
 * would replace content this run never saw.
 *
 * Args:
 *   bridge: the mount bridge to read and write through.
 *   path: mount path being extended.
 *   tail: bytes the guest appended.
 */
async function appendOnMount(bridge: MirageBridge, path: string, tail: Uint8Array): Promise<void> {
  let base: Uint8Array = new Uint8Array()
  try {
    base = await bridge.fetch(path)
  } catch (err) {
    if (!isMissingPath(err)) throw err
  }
  await bridge.flush(path, concatBytes(base, tail))
}

/**
 * Replay one recorded guest mutation against the mounts.
 *
 * Args:
 *   bridge: the mount bridge to apply through.
 *   mutation: the journal entry to apply.
 */
export async function applyMutation(bridge: MirageBridge, mutation: MirageMutation): Promise<void> {
  switch (mutation.kind) {
    case 'write':
      return bridge.flush(mutation.path, mutation.bytes)
    case 'append':
      return appendOnMount(bridge, mutation.path, mutation.bytes)
    case 'mkdir':
      return bridge.mkdir(mutation.path)
    case 'unlink':
      return bridge.unlink(mutation.path)
    case 'rmdir':
      return bridge.rmdir(mutation.path)
    case 'rename':
      return bridge.rename(mutation.path, mutation.dst)
  }
}

async function preloadEntry(fs: FSLike, bridge: MirageBridge, entry: MirageEntry): Promise<void> {
  if (entry.isDir) {
    fs.mkdirTree(entry.path)
    const next = entry.path.endsWith('/') ? entry.path : entry.path + '/'
    try {
      await preloadInto(fs, bridge, next)
    } catch (err) {
      console.warn(
        `mirage preload: skipping subtree ${next}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return
  }
  try {
    const bytes = await bridge.fetch(entry.path)
    fs.writeFile(entry.path, bytes)
  } catch (err) {
    console.warn(
      `mirage preload: skipping ${entry.path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function preloadInto(fs: FSLike, bridge: MirageBridge, prefix: string): Promise<void> {
  const prefixWithSlash = prefix.endsWith('/') ? prefix : prefix + '/'
  const prefixWithoutSlash = prefixWithSlash.slice(0, -1)
  fs.mkdirTree(prefixWithoutSlash)
  const entries = await bridge.list(prefixWithSlash)
  await Promise.all(entries.map((entry) => preloadEntry(fs, bridge, entry)))
}
