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

export class MontyUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MontyUnavailableError'
  }
}

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

export interface MontyModuleLike {
  Monty: { create(options?: Record<string, unknown>): Promise<MontyPoolLike> }
  NOT_HANDLED: symbol
  MontySyntaxError: new (...args: never[]) => Error
  MontyRuntimeError: new (...args: never[]) => Error
}

export interface MontyDisplayableError extends Error {
  display?: (format?: string) => string
}

/** Import the optional binding, failing loud when it is absent. */
export async function loadMontyModule(): Promise<MontyModuleLike> {
  try {
    return (await import('@pydantic/monty')) as unknown as MontyModuleLike
  } catch (err) {
    throw new MontyUnavailableError(MISSING_PACKAGE_HINT, { cause: err })
  }
}
