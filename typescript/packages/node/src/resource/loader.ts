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

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Extensions Node will import from disk. Python's twin tests for a
 * single one (`.py`) because it has one module language; here `.ts` and
 * `.mts` ride on Node's own type stripping, which is strip-only: a file
 * using `enum`, a parameter property, a runtime `namespace` or a legacy
 * decorator is refused at load with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
 * `.mjs` is the spelling with no caveats.
 */
export const MODULE_SUFFIXES = ['.mjs', '.cjs', '.mts', '.cts', '.js', '.ts']

/**
 * True when a ref's source is a file on disk rather than a package
 * specifier Node resolves for itself. Mirrors the `"/" in source or
 * source.endswith(".py")` test in `mirage/resource/loader.py`; the
 * config loader's `absolutizeCliRef` calls this same function so the
 * two cannot disagree about what a path is.
 */
export function isModulePath(source: string): boolean {
  return source.includes('/') || MODULE_SUFFIXES.some((suffix) => source.endsWith(suffix))
}

/** Split a `source:exportName` ref on its last colon. */
export function splitRef(spec: string): [string, string] {
  const cut = spec.lastIndexOf(':')
  if (cut < 0) {
    throw new Error(`invalid ref ${JSON.stringify(spec)}, expected 'source:ExportName'`)
  }
  return [spec.slice(0, cut), spec.slice(cut + 1)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ENOENT'
}

function isUnsupportedTypeScript(error: unknown): boolean {
  return isRecord(error) && error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
}

/**
 * Load a module export from a `source:exportName` reference.
 *
 * Two forms, auto-detected the way Python's `load_attr` detects them:
 * a file (`"./my_cli.mjs:TALLY"`) or a package specifier
 * (`"my-package/clis:JIRA"`). Only a missing file is reworded; every
 * other load failure propagates with Node's own diagnostic, because a
 * syntax error in the user's file is the message they need to read.
 *
 * A CommonJS file resolves through `default` as well as through named
 * exports, since cjs-module-lexer only detects some assignment shapes
 * and `module.exports = { TALLY }` is one it can miss.
 */
export async function loadAttr(spec: string): Promise<unknown> {
  const [source, attr] = splitRef(spec)
  // The file's own absence is checked here rather than caught from the
  // import, because a missing module is also what a bad import *inside*
  // the file raises: catching that would report the file we asked for as
  // missing when the file is fine and one of its dependencies is not.
  const path = isModulePath(source) ? (isAbsolute(source) ? source : resolve(source)) : null
  if (path !== null && !existsSync(path)) {
    throw new Error(`cannot load script ${JSON.stringify(source)}`)
  }
  const target = path !== null ? pathToFileURL(path).href : source
  let mod: Record<string, unknown>
  try {
    mod = (await import(target)) as Record<string, unknown>
  } catch (error) {
    if (path === null && isNotFound(error)) {
      throw new Error(`cannot load script ${JSON.stringify(source)}`)
    }
    if (isUnsupportedTypeScript(error)) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `cannot load script ${JSON.stringify(source)}: ${detail}. Node strips types ` +
          `without compiling them; precompile the file or ship it as .mjs.`,
      )
    }
    throw error
  }
  if (attr in mod) return mod[attr]
  const fallback = mod.default
  if (isRecord(fallback) && attr in fallback) return fallback[attr]
  throw new Error(`${JSON.stringify(attr)} not found in ${JSON.stringify(source)}`)
}
