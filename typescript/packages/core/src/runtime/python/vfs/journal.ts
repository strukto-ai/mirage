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

import { concatBytes, type RuntimeVFS } from '../../vfs.ts'

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
  | { readonly kind: 'mkdir'; readonly path: string }
  | { readonly kind: 'unlink'; readonly path: string }
  | { readonly kind: 'rmdir'; readonly path: string }
  | { readonly kind: 'rename'; readonly path: string; readonly dst: string }

/**
 * The write-ahead log a pyodide guest records into.
 *
 * Every mark is deliberately synchronous: the guest's close(), os.mkdir()
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
  markMkdir(path: string): void
  markUnlink(path: string): void
  markRmdir(path: string): void
  markRename(src: string, dst: string): void
  /** Drain the journal: every mutation in guest order, cleared. */
  takeMutations(): MirageMutation[]
}

export function createJournal(): MutationJournal {
  const journal: MirageMutation[] = []
  return {
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
    case 'mkdir':
      return vfs.mkdir(mutation.path)
    case 'unlink':
      return vfs.unlink(mutation.path)
    case 'rmdir':
      return vfs.rmdir(mutation.path)
    case 'rename':
      return vfs.rename(mutation.path, mutation.dst)
  }
}
