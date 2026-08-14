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

export interface AsyncStorage<T> {
  run<R>(store: T, fn: () => R | Promise<R>): R | Promise<R>
  getStore(): T | undefined
}

type ALSCtor = new <T>() => AsyncStorage<T>

class FallbackStorage<T> implements AsyncStorage<T> {
  private store: T | undefined

  run<R>(s: T, fn: () => R | Promise<R>): R | Promise<R> {
    const prev = this.store
    this.store = s
    try {
      const result = fn()
      if (result instanceof Promise) {
        return result.finally(() => {
          this.store = prev
        })
      }
      this.store = prev
      return result
    } catch (err) {
      this.store = prev
      throw err
    }
  }

  getStore(): T | undefined {
    return this.store
  }
}

async function resolveCtor(): Promise<ALSCtor> {
  const g = globalThis as unknown as {
    AsyncLocalStorage?: ALSCtor
    process?: { versions?: { node?: string } }
  }
  if (g.AsyncLocalStorage !== undefined) return g.AsyncLocalStorage
  if (g.process?.versions?.node !== undefined) {
    try {
      const modName = 'node:async_hooks'
      const mod = (await import(/* @vite-ignore */ modName)) as { AsyncLocalStorage: ALSCtor }
      return mod.AsyncLocalStorage
    } catch {
      return FallbackStorage as ALSCtor
    }
  }
  return FallbackStorage as ALSCtor
}

const AsyncStorageCtor: ALSCtor = await resolveCtor()

/**
 * Whether the resolved storage isolates concurrent tasks.
 *
 * `AsyncLocalStorage` gives every task its own store. The fallback is
 * one global slot restored when `run`'s promise settles, so work
 * started beside a still-running scope observes that scope's store;
 * a caller that binds a store for concurrent work has to know which
 * it got.
 */
export const asyncContextIsolatesTasks: boolean =
  (AsyncStorageCtor as unknown) !== (FallbackStorage as unknown)

export function createAsyncContext<T>(): AsyncStorage<T> {
  return new AsyncStorageCtor<T>()
}
