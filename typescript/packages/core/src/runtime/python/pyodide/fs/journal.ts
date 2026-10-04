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

import { type RuntimeVFS } from '../../../vfs.ts'
import type { SetAttrFields } from '../../../../types.ts'
import { concat } from '../../../../io/cachable_iterator.ts'

/**
 * One guest mutation, recorded in the order the script performed it.
 * `write` and `append` carry their bytes because the drain runs after the
 * script returns, when the filesystem holds only the final state: an
 * atomic-write (write a temp file, rename it into place) would otherwise
 * replay as a read of a path the rename already moved.
 */
export type MirageMutation =
  | { readonly kind: 'write'; readonly path: string; readonly bytes: Uint8Array }
  | { readonly kind: 'append'; readonly path: string; readonly bytes: Uint8Array }
  | {
      readonly kind: 'pwrite'
      readonly path: string
      readonly offset: number
      readonly bytes: Uint8Array
    }
  | { readonly kind: 'truncate'; readonly path: string; readonly length: number }
  | { readonly kind: 'mkdir'; readonly path: string }
  | { readonly kind: 'unlink'; readonly path: string }
  | { readonly kind: 'rmdir'; readonly path: string }
  | { readonly kind: 'rename'; readonly path: string; readonly dst: string }
  | { readonly kind: 'symlink'; readonly path: string; readonly target: string }
  | { readonly kind: 'setattr'; readonly path: string; readonly attrs: SetAttrFields }

/**
 * The write-ahead log a pyodide guest records into.
 *
 * Every mark is deliberately synchronous: the guest's write(), os.mkdir()
 * and os.rename() run inside sync WASM frames where awaiting a mount op
 * needs JSPI stack switching, which most engines do not enable. The guest
 * records here and the runtime replays after the script returns, where
 * awaiting is free. This is the one thing pyodide needs that the other
 * runtimes do not: quickjs suspends at the call and monty runs the op on
 * its own worker.
 */
export interface MutationJournal {
  /**
   * Args:
   *   path: mount-prefixed path the mutation names.
   *   bytes: the whole file for a write, the new tail for an append.
   */
  markWrite(path: string, bytes: Uint8Array): void
  markAppend(path: string, bytes: Uint8Array): void
  /**
   * Args:
   *   path: mount-prefixed path the mutation names.
   *   offset: where the bytes land inside the file.
   *   bytes: the bytes written there.
   */
  markPwrite(path: string, offset: number, bytes: Uint8Array): void
  /**
   * Args:
   *   path: mount-prefixed path the mutation names.
   *   length: the length the file is left at.
   */
  markTruncate(path: string, length: number): void
  markMkdir(path: string): void
  markUnlink(path: string): void
  markRmdir(path: string): void
  markRename(src: string, dst: string): void
  /**
   * Args:
   *   path: guest-absolute path of the link.
   *   target: what it points at, stored verbatim.
   */
  markSymlink(path: string, target: string): void
  /**
   * Args:
   *   path: guest-absolute path whose metadata changed.
   *   attrs: only the fields the guest wrote, already in the op's own
   *     terms (ISO stamps), because the unit Emscripten passes is the
   *     caller's fact and not the journal's.
   */
  markSetattr(path: string, attrs: SetAttrFields): void
  /** Drain the journal: every mutation in guest order, cleared. */
  takeMutations(): MirageMutation[]
}

// A write, append or pwrite holds its bytes as parts until the drain, so a
// loop of small writes costs one copy per write rather than one per byte
// written so far.
type Pending =
  | Exclude<MirageMutation, { kind: 'write' | 'append' | 'pwrite' }>
  | { kind: 'write'; path: string; parts: Uint8Array[] }
  | { kind: 'append'; path: string; parts: Uint8Array[] }
  | { kind: 'pwrite'; path: string; offset: number; parts: Uint8Array[]; length: number }

export function createJournal(): MutationJournal {
  const journal: Pending[] = []
  return {
    markWrite(path, bytes) {
      // A guest buffer handed over by pyodide can be a view into WASM
      // memory, which relocates when the heap grows; copy on arrival so
      // the journal owns bytes that stay valid until the drain.
      const owned = new Uint8Array(bytes)
      const last = journal[journal.length - 1]
      // A whole write replaces what the file held, so a write or a truncate
      // just before it on the same path says nothing the mount still needs.
      if ((last?.kind === 'write' || last?.kind === 'truncate') && last.path === path) {
        journal[journal.length - 1] = { kind: 'write', path, parts: [owned] }
        return
      }
      journal.push({ kind: 'write', path, parts: [owned] })
    },
    markAppend(path, bytes) {
      const owned = new Uint8Array(bytes)
      const last = journal[journal.length - 1]
      if ((last?.kind === 'append' || last?.kind === 'write') && last.path === path) {
        last.parts.push(owned)
        return
      }
      journal.push({ kind: 'append', path, parts: [owned] })
    },
    markPwrite(path, offset, bytes) {
      const owned = new Uint8Array(bytes)
      const last = journal[journal.length - 1]
      if (last?.kind === 'pwrite' && last.path === path && last.offset + last.length === offset) {
        last.parts.push(owned)
        last.length += owned.length
        return
      }
      journal.push({ kind: 'pwrite', path, offset, parts: [owned], length: owned.length })
    },
    markTruncate(path, length) {
      journal.push({ kind: 'truncate', path, length })
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
    markSymlink(path, target) {
      journal.push({ kind: 'symlink', path, target })
    },
    markSetattr(path, attrs) {
      journal.push({ kind: 'setattr', path, attrs })
    },
    takeMutations() {
      return journal.splice(0, journal.length).map((entry): MirageMutation => {
        if (entry.kind === 'write') {
          return { kind: 'write', path: entry.path, bytes: concat(entry.parts) }
        }
        if (entry.kind === 'append') {
          return { kind: 'append', path: entry.path, bytes: concat(entry.parts) }
        }
        if (entry.kind === 'pwrite') {
          return {
            kind: 'pwrite',
            path: entry.path,
            offset: entry.offset,
            bytes: concat(entry.parts),
          }
        }
        return entry
      })
    },
  }
}

/**
 * Replay one recorded guest mutation against the mounts.
 *
 * Args:
 *   vfs: the runtime's mount vocabulary to apply through.
 *   mutation: the journal entry to apply.
 */
export async function applyMutation(vfs: RuntimeVFS, mutation: MirageMutation): Promise<void> {
  switch (mutation.kind) {
    case 'write':
      return vfs.write(mutation.path, mutation.bytes)
    // The journal recorded only the tail, so the whole file is not
    // available here; RuntimeVFS.append reads the base itself when the
    // mount has no append op.
    case 'append':
      return vfs.append(mutation.path, mutation.bytes)
    case 'pwrite':
      return vfs.pwrite(mutation.path, mutation.offset, mutation.bytes)
    case 'truncate':
      return vfs.truncate(mutation.path, mutation.length)
    case 'mkdir':
      return vfs.mkdir(mutation.path)
    case 'unlink':
      return vfs.unlink(mutation.path)
    case 'rmdir':
      return vfs.rmdir(mutation.path)
    case 'rename':
      return vfs.rename(mutation.path, mutation.dst)
    case 'symlink':
      return vfs.symlink(mutation.path, mutation.target)
    case 'setattr':
      return vfs.setattr(mutation.path, mutation.attrs)
  }
}
