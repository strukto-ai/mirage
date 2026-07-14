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

import { PyodideUnavailableError } from './types.ts'

const noopIo = (): void => undefined

const PYODIDE_CDN_VERSION = '0.29.3'
const PYODIDE_CDN_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_CDN_VERSION}/full/`

interface PyodideFS {
  mkdirTree: (path: string, mode?: number) => void
  writeFile: (path: string, data: Uint8Array | string) => void
  readFile: (path: string, opts?: { encoding?: 'binary' | 'utf8' }) => Uint8Array | string
  unlink?: (path: string) => void
}

export interface PyodideInterface {
  globals: {
    set: (key: string, value: unknown) => void
    get: (key: string) => unknown
    delete?: (key: string) => void
  }
  runPythonAsync: (code: string, options?: { globals?: unknown }) => Promise<unknown>
  toPy: (obj: unknown) => unknown
  isPyProxy?: (obj: unknown) => boolean
  loadPackagesFromImports?: (code: string, options?: Record<string, unknown>) => Promise<unknown>
  registerJsModule: (name: string, module: unknown) => void
  unregisterJsModule?: (name: string) => void
  FS: PyodideFS
}

function isNode(): boolean {
  const proc = (globalThis as { process?: { versions?: Record<string, string> } }).process
  return typeof proc?.versions?.node === 'string'
}

async function resolveNodeIndexURL(): Promise<string | null> {
  if (!isNode()) return null
  try {
    const nodeModule = await import('node:module')
    const nodePath = await import('node:path')
    const require = nodeModule.createRequire(import.meta.url)
    const entry = require.resolve('pyodide')
    const dir = nodePath.dirname(entry)
    return `${dir}/`
  } catch {
    return null
  }
}

export async function loadPyodideRuntime(): Promise<PyodideInterface> {
  let mod: { loadPyodide: (opts?: Record<string, unknown>) => Promise<unknown> }
  try {
    mod = (await import('pyodide')) as unknown as {
      loadPyodide: (opts?: Record<string, unknown>) => Promise<unknown>
    }
  } catch (err) {
    throw new PyodideUnavailableError(
      'python3 requires the optional `pyodide` peer dependency. Install it with `npm i pyodide`.',
      { cause: err },
    )
  }
  const nodeIndexURL = await resolveNodeIndexURL()
  const indexURL = nodeIndexURL ?? (isNode() ? null : PYODIDE_CDN_URL)
  const opts: Record<string, unknown> = { stdout: noopIo, stderr: noopIo }
  if (indexURL !== null) opts.indexURL = indexURL
  try {
    const runtime = await mod.loadPyodide(opts)
    return runtime as PyodideInterface
  } catch (err) {
    throw new PyodideUnavailableError(
      `python3: failed to initialize pyodide runtime: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}
