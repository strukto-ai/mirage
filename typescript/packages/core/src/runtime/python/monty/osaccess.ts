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

import type { MontyVFS } from './vfs.ts'

function pathArg(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && 'path' in value) {
    const p = (value as { path: unknown }).path
    return typeof p === 'string' ? p : null
  }
  return null
}

/**
 * Monty's OS door, serving the guest's `os` and `pathlib` calls.
 *
 * This is monty's tier of the interception taxonomy: the binding calls
 * one host callback per operation and takes back either a value (or a
 * promise of one) or NOT_HANDLED, in which case monty falls back to
 * its own in-memory tree. That is the whole seam, which is why this
 * side is a value-returning table rather than the subclass Python's
 * binding hands over, and why the runtime needs no interpreter patch.
 *
 * Declining is load-bearing, not an error path: a path under no mount
 * must reach monty's own tree, so `/tmp` still behaves like `/tmp`.
 *
 * Args:
 *   notHandled: the binding's NOT_HANDLED sentinel.
 *   env: the run's environment, readable both ways python's monty
 *     spells it (`os.getenv` and `os.environ`).
 *   vfs: the mount view, or null when no workspace is attached.
 */
export class MirageOSAccess {
  private readonly notHandled: symbol
  private readonly env: Record<string, string>
  private readonly vfs: MontyVFS | null

  constructor(notHandled: symbol, env: Record<string, string>, vfs: MontyVFS | null) {
    this.notHandled = notHandled
    this.env = env
    this.vfs = vfs
  }

  readonly handle = (name: string, args: unknown[]): unknown => {
    if (name === 'os.getenv') {
      // hasOwn, not `in`: the guest picks the key, so a name like
      // `toString` must miss instead of leaking a host function.
      const key = String(args[0])
      if (Object.hasOwn(this.env, key)) return this.env[key]
      return args.length > 1 ? args[1] : null
    }
    if (name === 'os.environ') {
      // The engine asks for the whole mapping as one call; a plain
      // object arrives in the guest as a dict, so `.get`, `[...]`,
      // `in`, iteration and len all work, and a missing key raises
      // KeyError. Declining instead raised "'os.environ' is not
      // supported in this environment", which made a program written
      // against the python host fail here (integ/runtime caught it).
      // A copy, like python's OSAccess(environ=dict(environ)): a
      // guest that mutates it cannot reach the session's own env.
      return { ...this.env }
    }
    // Everything below serves a path through the mounts; the env doors
    // above need no mount.
    const vfs = this.vfs
    if (vfs === null) return this.notHandled
    const path = pathArg(args[0])
    if (path === null || !vfs.serves(path)) return this.notHandled
    switch (name) {
      case 'Path.read_bytes':
        return vfs.read(path)
      case 'Path.read_text':
        return vfs.read(path).then((b) => new TextDecoder().decode(b))
      case 'Path.write_bytes':
      case 'Path.write_text':
        return vfs.write(path, args[1])
      case 'Path.mkdir':
        return vfs.mkdir(path)
      case 'Path.rmdir':
        return vfs.rmdir(path)
      case 'Path.unlink':
        return vfs.unlink(path)
      case 'Path.rename': {
        const dst = pathArg(args[1])
        // A destination outside the workspace has no mount to rename
        // into; decline rather than half-apply the move.
        if (dst === null || !vfs.serves(dst)) return this.notHandled
        return vfs.rename(path, dst)
      }
      case 'Path.iterdir':
        return vfs.readdir(path).then((entries) => entries.map((e) => e.path))
      case 'Path.is_dir':
        return vfs.readdir(path).then(
          () => true,
          () => false,
        )
      case 'Path.is_file':
        return vfs.entryFor(path).then(
          (e) => e !== null && !e.isDir,
          () => false,
        )
      case 'Path.exists':
        return vfs.entryFor(path).then(
          (e) => e !== null,
          () =>
            vfs.readdir(path).then(
              () => true,
              () => false,
            ),
        )
      default:
        return this.notHandled
    }
  }
}
