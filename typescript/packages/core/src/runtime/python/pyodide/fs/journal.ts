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

import { type RuntimeFiles } from '../../../files.ts'
import type { SetAttrFields } from '../../../../types.ts'
import { concat } from '../../../../utils/bytes.ts'

/**
 * One guest mutation, recorded in the order the script performed it.
 * `pwrite` and `append` carry their bytes because the drain runs after
 * the script returns, when the filesystem holds only the final state: an
 * atomic-write (write a temp file, rename it into place) would otherwise
 * replay as a read of a path the rename already moved.
 */
export type MirageMutation =
  | { readonly kind: 'create'; readonly path: string }
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
  markCreate(path: string): void
  /**
   * Args:
   *   path: mount-prefixed path the mutation names.
   *   offset: where the file ended, which is where the tail lands.
   *   bytes: the new tail.
   */
  markAppend(path: string, offset: number, bytes: Uint8Array): void
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
  /**
   * Record nothing more until `reopen`: the guest called `os._exit`, and
   * a process that exited writes nothing after it, even when the guest
   * catches the exit and runs on.
   */
  seal(): void
  /** Record again, for the next run. */
  reopen(): void
}

// An append or pwrite holds its bytes as parts until the drain, so a loop
// of small writes costs one copy per write rather than one per byte
// written so far.
type Pending =
  | Exclude<MirageMutation, { kind: 'append' | 'pwrite' }>
  | { kind: 'append'; path: string; parts: Uint8Array[] }
  | { kind: 'pwrite'; path: string; offset: number; parts: Uint8Array[]; length: number }

export function createJournal(): MutationJournal {
  const journal: Pending[] = []
  let sealed = false
  const record = (entry: Pending): void => {
    if (!sealed) journal.push(entry)
  }
  return {
    markCreate(path) {
      record({ kind: 'create', path })
    },
    markAppend(path, offset, bytes) {
      if (sealed) return
      // A guest buffer handed over by pyodide can be a view into WASM
      // memory, which relocates when the heap grows; copy on arrival so
      // the journal owns bytes that stay valid until the drain.
      const owned = new Uint8Array(bytes)
      const last = journal[journal.length - 1]
      // A tail continues the append before it, or a pwrite that reached
      // the old end, as one range.
      if (last?.kind === 'append' && last.path === path) {
        last.parts.push(owned)
        return
      }
      if (last?.kind === 'pwrite' && last.path === path && last.offset + last.length === offset) {
        last.parts.push(owned)
        last.length += owned.length
        return
      }
      record({ kind: 'append', path, parts: [owned] })
    },
    markPwrite(path, offset, bytes) {
      if (sealed) return
      const owned = new Uint8Array(bytes)
      const last = journal[journal.length - 1]
      if (last?.kind === 'pwrite' && last.path === path && last.offset + last.length === offset) {
        last.parts.push(owned)
        last.length += owned.length
        return
      }
      record({ kind: 'pwrite', path, offset, parts: [owned], length: owned.length })
    },
    markTruncate(path, length) {
      record({ kind: 'truncate', path, length })
    },
    markMkdir(path) {
      record({ kind: 'mkdir', path })
    },
    markUnlink(path) {
      record({ kind: 'unlink', path })
    },
    markRmdir(path) {
      record({ kind: 'rmdir', path })
    },
    markRename(src, dst) {
      record({ kind: 'rename', path: src, dst })
    },
    markSymlink(path, target) {
      record({ kind: 'symlink', path, target })
    },
    markSetattr(path, attrs) {
      record({ kind: 'setattr', path, attrs })
    },
    seal() {
      sealed = true
    },
    reopen() {
      sealed = false
    },
    takeMutations() {
      return journal.splice(0, journal.length).map((entry): MirageMutation => {
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
 *   files: the runtime's mount vocabulary to apply through.
 *   mutation: the journal entry to apply.
 */
export async function applyMutation(files: RuntimeFiles, mutation: MirageMutation): Promise<void> {
  switch (mutation.kind) {
    case 'create':
      return files.create(mutation.path)
    // The journal recorded only the tail, so the whole file is not
    // available here; RuntimeFiles.append reads the base itself when the
    // mount has no append op.
    case 'append':
      return files.append(mutation.path, mutation.bytes)
    case 'pwrite':
      return files.pwrite(mutation.path, mutation.offset, mutation.bytes)
    case 'truncate':
      return files.truncate(mutation.path, mutation.length)
    case 'mkdir':
      return files.mkdir(mutation.path)
    case 'unlink':
      return files.unlink(mutation.path)
    case 'rmdir':
      return files.rmdir(mutation.path)
    case 'rename':
      return files.rename(mutation.path, mutation.dst)
    case 'symlink':
      return files.symlink(mutation.path, mutation.target)
    case 'setattr':
      return files.setattr(mutation.path, mutation.attrs)
  }
}
