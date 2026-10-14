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

import { PyodideUnavailableError } from './errors.ts'

const HOST_GLOBALS = ['process', 'global', 'require', 'fetch', 'WebSocket'] as const
const HOST_FILESYSTEMS = ['NODEFS', 'NODERAWFS', 'NATIVEFS_ASYNC'] as const
const HOST_METHODS = ['mountNodeFS', 'mountNativeFS', 'useNodeSockFS'] as const
const HOST_PRELOAD_METHODS = [
  'createLazyFile',
  'forceLoadFile',
  'createPreloadedFile',
  'preloadFile',
] as const

type HostFunction = (...args: never[]) => unknown

interface SealablePyodide {
  FS?: unknown
  _module?: unknown
  _api?: {
    config?: { indexURL?: string; packageBaseUrl?: string; packageCacheDir?: string }
    loadBinaryFile?: (path: string, ...rest: unknown[]) => unknown
  }
}

/** Remove host handles, returning any names that could not be removed. */
export function stripWorkerGlobals(realm: Record<string, unknown>): string[] {
  const left: string[] = []
  for (const name of HOST_GLOBALS) {
    if (!(name in realm)) continue
    Reflect.deleteProperty(realm, name)
    if (name in realm && !Reflect.defineProperty(realm, name, { value: undefined })) {
      left.push(name)
    }
  }
  return left
}

function refused(name: string): HostFunction {
  return (): never => {
    throw new Error(`python3: ${name} is disabled in the sandboxed worker`)
  }
}

/** Match Pyodide's Node loader, which strips file:// before reading disk. */
function localPath(path: string): string | null {
  const value = path.startsWith('file://') ? path.slice('file://'.length) : path
  return value.includes('://') ? null : value
}

/**
 * Restrict binary reads to the configured distribution, including real paths
 * behind symlinks. Capture the roots before guest code can mutate config.
 *
 * @param pyodide The loaded interpreter.
 */
async function guardLoadBinaryFile(pyodide: SealablePyodide): Promise<void> {
  const api = pyodide._api
  const original = api?.loadBinaryFile
  if (api === undefined || typeof original !== 'function') return
  const nodePath = await import('node:path')
  const { realpath } = await import('node:fs/promises')
  const cwd = nodePath.resolve('.')
  const roots = [api.config?.indexURL, api.config?.packageBaseUrl, api.config?.packageCacheDir]
    .map((url) => (typeof url === 'string' ? localPath(url) : null))
    .filter((root): root is string => root !== null && root.length > 0)
    .map((root) => nodePath.resolve(cwd, root))
  const inside = (root: string, path: string): boolean => {
    const tail = nodePath.relative(root, path)
    return tail !== '..' && !tail.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(tail)
  }
  api.loadBinaryFile = (path: string, ...rest: unknown[]): Promise<unknown> => {
    const local = typeof path === 'string' ? localPath(path) : null
    const absolute = local === null ? null : nodePath.resolve(cwd, local)
    const matching = absolute === null ? [] : roots.filter((root) => inside(root, absolute))
    if (matching.length === 0 || absolute === null) {
      throw new Error(`python3: reading '${path}' is not allowed in the sandboxed worker`)
    }
    return Promise.all([
      Promise.all(matching.map((root) => realpath(root))),
      realpath(absolute),
    ]).then(([canonicalRoots, canonicalPath]) => {
      if (!canonicalRoots.some((root) => inside(root, canonicalPath))) {
        throw new Error(`python3: reading '${path}' is not allowed in the sandboxed worker`)
      }
      return original.call(api, canonicalPath, ...rest)
    })
  }
  const module = pyodide._module as Record<string, unknown> | undefined
  if (module !== undefined && typeof module.asyncLoad === 'function') {
    module.asyncLoad = api.loadBinaryFile
  }
}

/**
 * Close the exposed Pyodide APIs that captured host filesystem handles at load.
 * This is worker hardening, not an isolation boundary against arbitrary JS.
 *
 * @param pyodide The loaded interpreter.
 */
export async function sealPyodideHostApis(pyodide: SealablePyodide): Promise<void> {
  await guardLoadBinaryFile(pyodide)
  const fs = pyodide.FS as Record<string, unknown> | undefined
  const module = pyodide._module as Record<string, unknown> | undefined
  const filesystems = fs?.filesystems as Record<string, unknown> | undefined
  for (const table of [filesystems, module]) {
    if (table === undefined) continue
    for (const name of HOST_FILESYSTEMS) Reflect.deleteProperty(table, name)
  }
  for (const name of HOST_PRELOAD_METHODS) {
    if (fs !== undefined && typeof fs[name] === 'function') fs[name] = refused(`FS.${name}()`)
    const exported = `FS_${name}`
    if (module !== undefined && typeof module[exported] === 'function') {
      module[exported] = refused(`${exported}()`)
    }
  }
  const publicApi = pyodide as Record<string, unknown>
  for (const name of HOST_METHODS) {
    if (typeof publicApi[name] === 'function') publicApi[name] = refused(`${name}()`)
  }
  const api = pyodide._api as Record<string, unknown> | undefined
  if (api !== undefined && typeof api.initializeNodeSockFS === 'function') {
    api.initializeNodeSockFS = refused('initializeNodeSockFS()')
  }
}

function denyModule(specifier: string): never {
  throw new Error(`python3: module '${specifier}' cannot be loaded in the sandboxed worker`)
}

/**
 * Seal one Node worker after initialization and before guest execution. Older
 * Node releases without synchronous module hooks deliberately remain unsealed.
 *
 * @param pyodide The loaded interpreter.
 * @param realm The worker's global object.
 */
export async function sealWorkerRealm(
  pyodide: SealablePyodide,
  realm: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): Promise<void> {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks !== 'function') return
  await sealPyodideHostApis(pyodide)
  registerHooks({ resolve: denyModule })
  const left = stripWorkerGlobals(realm)
  if (left.length > 0) {
    throw new PyodideUnavailableError(
      `python3: could not remove worker handles: ${left.join(', ')}`,
    )
  }
}
