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
import type { OpenMode } from '../../../handles/mode.ts'
import type { SetAttrFields } from '../../../../types.ts'

// What a create opens: a file made and never written still lands.
const CREATE: OpenMode = Object.freeze({
  readable: false,
  writable: true,
  truncate: false,
  append: false,
  create: true,
  exclusive: false,
  binary: true,
})

/**
 * One guest change to names or metadata, recorded in the order the script
 * performed it. A file's bytes are not here: its stream writes through
 * its core handle (`SyncVFS.pwrite`).
 */
export type MirageMutation =
  | { readonly kind: 'create'; readonly path: string }
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
 * Every mark is deliberately synchronous: the guest's os.mkdir() and
 * os.rename() run inside sync WASM frames where awaiting a mount op
 * needs JSPI stack switching, which most engines do not enable. The guest
 * records here and the runtime replays after the script returns, where
 * awaiting is free. This is the one thing pyodide needs that the other
 * runtimes do not: quickjs suspends at the call and monty runs the op on
 * its own worker.
 */
export interface MutationJournal {
  markCreate(path: string): void
  /**
   * Take back the create of `path` the journal ends with, which the open
   * right after it makes instead; false when it ends with no such create.
   */
  takeCreate(path: string): boolean
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
  /** Whether the guest exited since the last `reopen`: its streams read and write nothing more either. */
  readonly sealed: boolean
  /** Record again, for the next run. */
  reopen(): void
}

export function createJournal(): MutationJournal {
  const journal: MirageMutation[] = []
  let sealed = false
  const record = (entry: MirageMutation): void => {
    if (!sealed) journal.push(entry)
  }
  return {
    markCreate(path) {
      record({ kind: 'create', path })
    },
    takeCreate(path) {
      const last = journal.at(-1)
      if (last?.kind !== 'create' || last.path !== path) return false
      journal.pop()
      return true
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
    get sealed() {
      return sealed
    },
    reopen() {
      sealed = false
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
 *   files: the runtime's mount vocabulary to apply through.
 *   mutation: the journal entry to apply.
 */
export async function applyMutation(files: RuntimeFiles, mutation: MirageMutation): Promise<void> {
  switch (mutation.kind) {
    case 'create':
      return files.close(await files.open(mutation.path, CREATE))
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
