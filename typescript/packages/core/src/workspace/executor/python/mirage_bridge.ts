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

export interface MirageEntry {
  path: string
  size: number
  isDir: boolean
}

export interface FSLike {
  mkdirTree(path: string): void
  writeFile(path: string, bytes: Uint8Array): void
}

export type BridgeDispatchFn = (
  op: 'READ' | 'WRITE' | 'LIST',
  path: string,
  bytes?: Uint8Array,
) => Promise<unknown>

export interface MirageBridge {
  fetch(path: string): Promise<Uint8Array>
  flush(path: string, bytes: Uint8Array): Promise<void>
  list(path: string): Promise<MirageEntry[]>
  /**
   * Live view of the workspace mount prefixes (trailing-slash normalized).
   * The fs shim consults this on every intercepted call, so the mount
   * registry stays the single source of truth: nothing is pushed into the
   * interpreter when mounts are added or removed.
   */
  prefixes(): string[]
}

export function createMirageBridge(
  dispatch: BridgeDispatchFn,
  listMounts: () => string[] = () => [],
): MirageBridge {
  return {
    prefixes() {
      return listMounts().map((p) => (p.endsWith('/') ? p : p + '/'))
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
