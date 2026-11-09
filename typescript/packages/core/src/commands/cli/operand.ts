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

import { fsStrerror, isEnotdir, isMissingPath } from '../../errors/fs.ts'
import { posixPhrase } from '../../errors/posix.ts'
import type { PathSpec } from '../../types.ts'
import type { Files } from '../../workspace/files.ts'

/** The command's first operand, refused when absent or empty. */
export function firstText(texts: readonly string[], label: string): string {
  const value = texts[0]
  if (value === undefined || value === '') throw new Error(`${label} is required`)
  return value
}

/**
 * Read the workspace file a flag names. An account CLI has no mount of its
 * own, so a file on its line is an unrelated workspace file, read through the
 * session's files.
 */
export async function readOperand(
  vfs: Files | undefined,
  path: PathSpec,
  flag: string,
  label = 'read',
): Promise<Uint8Array> {
  if (vfs === undefined) throw new Error(`${flag} needs a workspace to read files from`)
  try {
    return await vfs.read(path)
  } catch (err) {
    if (isMissingPath(err) || isEnotdir(err)) {
      throw new Error(`${label} ${path.virtual}: ${fsStrerror(err) ?? posixPhrase('ENOENT')}`)
    }
    throw err
  }
}

/**
 * Create a directory and every missing directory above it.
 *
 * Written out rather than delegated to `mkdir -p` because the parents flag is
 * a per-backend capability: the ops factory only wires `parents: true` for
 * backends that declare it, so a plain `mkdir` of `a/b` fails on the rest.
 */
export async function ensureDir(vfs: Files, path: PathSpec): Promise<void> {
  const missing: PathSpec[] = []
  let current = path
  while (current.virtual !== '/') {
    try {
      await vfs.stat(current)
      break
    } catch (err) {
      if (!isMissingPath(err)) throw err
      missing.push(current)
      current = current.parent
    }
  }
  for (const target of missing.reverse()) {
    try {
      await vfs.mkdir(target)
    } catch (err) {
      // A parallel download fans out over files that share parents, so two
      // workers can read the same parent as missing and then both create
      // it. EEXIST here says the directory is present, which is what the
      // caller asked for; rethrowing would fail the whole Promise.all over
      // a race that already succeeded.
      if ((err as { code?: unknown }).code !== 'EEXIST') throw err
    }
  }
}
