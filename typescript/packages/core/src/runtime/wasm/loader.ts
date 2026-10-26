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

/**
 * A wasm module's bytes, found under `home`: a directory on disk, where
 * Node reads it, or a URL, which a page (or Node) fetches. A page reads
 * a relative URL against its own. Python's `loader` imports wasmtime,
 * which reads the module from disk itself.
 *
 * @param home - the directory or URL the module is in.
 * @param name - the module's file name.
 */
export async function loadWasm(home: string, name: string): Promise<Uint8Array> {
  const page = (globalThis as { location?: { href: string } }).location?.href
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(home) || node === undefined) {
    const base = new URL(home.endsWith('/') ? home : `${home}/`, page)
    const response = await fetch(new URL(name, base))
    if (!response.ok) {
      throw Object.assign(new Error(`no ${name} at ${base.href} (${String(response.status)})`), {
        code: 'ENOENT',
      })
    }
    return new Uint8Array(await response.arrayBuffer())
  }
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  return new Uint8Array(await fs.readFile(path.join(home, name)))
}
