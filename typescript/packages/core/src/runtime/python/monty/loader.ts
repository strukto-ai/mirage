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

import { MISSING_PACKAGE_HINT } from './constants.ts'
import { MontyUnavailableError } from './errors.ts'

// Structural views of @pydantic/monty so its types never leak into our
// public .d.ts (the package is an optional peer dependency). Python
// gets the same isolation from a try/except ImportError block that
// leaves the names None.
export interface MontySessionLike {
  readonly workerPid?: number
  feedRun(code: string, options?: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

export interface MontyPoolLike {
  checkout(options?: Record<string, unknown>): Promise<MontySessionLike>
  close(): Promise<void>
}

/**
 * The three pieces `MontyFs` needs from the engine: the decline
 * sentinel, the handle class an `open` answer must be an instance of
 * (the engine wraps it into the guest's `_io.*` object),
 * and the wrapper that carries a host object into the guest as a class
 * instance rather than a dict, which is what lets a stat answer arrive
 * with `st_size` on it.
 */
export interface MontyFsBits {
  NOT_HANDLED: symbol
  MontyFileHandle: new (path: string, mode: string, options?: { position: number }) => unknown
  ClassInstance: new (
    instance: object,
    options?: {
      name?: string
      eagerAttrs?: readonly string[] | 'all'
    },
  ) => object
}

export interface MontyModuleLike extends MontyFsBits {
  Monty: { create(options?: Record<string, unknown>): Promise<MontyPoolLike> }
  MontySyntaxError: new (...args: never[]) => Error
  MontyRuntimeError: new (...args: never[]) => Error
  /** A worker-death error, the one shape run() maps to an exit code. */
  MontyCrashedError: new (...args: never[]) => Error & { timedOut: boolean }
}

/**
 * The path a callback argument names: a string, or a path object carrying
 * one; null for anything else. Python's engine exports this as
 * `pydantic_monty.os_access.path_from_arg`; the JS package does not.
 */
export function pathFromArg(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && 'path' in value) {
    const p = (value as { path: unknown }).path
    return typeof p === 'string' ? p : null
  }
  return null
}

let provided: (() => Promise<MontyModuleLike>) | undefined

/**
 * Use the host's monty module in place of `@pydantic/monty`'s own: a runtime
 * that cannot start a worker (an edge runtime) hands in one whose pool
 * runs each program in the same isolate. Set it before the first run.
 */
export function provideMontyModule(load: () => Promise<MontyModuleLike>): void {
  provided = load
}

/** Whether runs share the host's own thread: the host provided monty. */
export function sharesThread(): boolean {
  return provided !== undefined
}

/** Import the optional engine package, failing loud when it is absent. */
export async function loadMontyModule(): Promise<MontyModuleLike> {
  if (provided !== undefined) return provided()
  try {
    return (await import('@pydantic/monty')) as unknown as MontyModuleLike
  } catch (err) {
    throw new MontyUnavailableError(MISSING_PACKAGE_HINT, { cause: err })
  }
}
