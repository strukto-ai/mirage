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

export type ContextCall = <R>(fn: () => R | Promise<R>) => R | Promise<R>

export interface AsyncStorage<T> {
  run<R>(store: T, fn: () => R | Promise<R>): R | Promise<R>
  getStore(): T | undefined
  /**
   * Every store bound by a live `run`, oldest first.
   *
   * On an isolating runtime that is the current task's store alone,
   * because `AsyncLocalStorage` cannot enumerate other tasks and the
   * isolated world never needs it to. On the fallback it is the honest
   * answer the single slot cannot give — all concurrently live
   * bindings — so a reader can merge conservatively instead of
   * trusting whichever binding happens to sit in the slot. The array
   * is a snapshot; it does not track later binds or settles.
   */
  liveStores(): readonly T[]
  capture(): ContextCall
}

interface TaskStorage<T> {
  run<R>(store: T, fn: () => R | Promise<R>): R | Promise<R>
  getStore(): T | undefined
}

type ALSCtor = (new <T>() => TaskStorage<T>) & { snapshot?: () => ContextCall }

/**
 * The browser storage: no task isolation, one frame stack per storage.
 *
 * `getStore` answers the newest live frame, so a read that interleaves
 * with another task's bind can still see that task's store — only real
 * isolation fixes that, which is what `liveStores` exists to route
 * around. What the stack does fix is the slot's two worse failures: a
 * settle removes its own frame rather than blind-restoring a saved
 * value, so an out-of-order settle can neither wipe a binding that is
 * still live nor strand a stale one after every run has finished.
 *
 * Exported for the fallback-mode tests, which mock `createAsyncContext`
 * with this class so the browser branch runs under node's test runner.
 */
export class FallbackStorage<T> implements AsyncStorage<T> {
  private frames: { store: T | undefined }[] = []

  run<R>(s: T, fn: () => R | Promise<R>): R | Promise<R> {
    return this.withFrame(s, fn)
  }

  private withFrame<R>(s: T | undefined, fn: () => R | Promise<R>): R | Promise<R> {
    const frame = { store: s }
    this.frames.push(frame)
    const drop = (): void => {
      const at = this.frames.indexOf(frame)
      if (at >= 0) this.frames.splice(at, 1)
    }
    try {
      const result = fn()
      if (result instanceof Promise) {
        return result.finally(drop)
      }
      drop()
      return result
    } catch (err) {
      drop()
      throw err
    }
  }

  getStore(): T | undefined {
    return this.frames.length === 0 ? undefined : this.frames[this.frames.length - 1]?.store
  }

  liveStores(): readonly T[] {
    return this.frames
      .map((frame) => frame.store)
      .filter((store): store is T => store !== undefined)
  }

  capture(): ContextCall {
    const frames = this.frames.length === 0 ? [undefined] : this.frames.map((frame) => frame.store)
    return <R>(fn: () => R | Promise<R>): R | Promise<R> => {
      const enter = (at: number): R | Promise<R> =>
        at === frames.length ? fn() : this.withFrame(frames[at], () => enter(at + 1))
      return enter(0)
    }
  }
}

class IsolatedStorage<T> implements AsyncStorage<T> {
  private readonly tasks: TaskStorage<T | undefined>

  constructor(ctor: ALSCtor) {
    this.tasks = new ctor<T | undefined>()
  }

  run<R>(store: T, fn: () => R | Promise<R>): R | Promise<R> {
    return this.tasks.run(store, fn)
  }

  getStore(): T | undefined {
    return this.tasks.getStore()
  }

  liveStores(): readonly T[] {
    const store = this.tasks.getStore()
    return store === undefined ? [] : [store]
  }

  capture(): ContextCall {
    const store = this.tasks.getStore()
    return (fn) => this.tasks.run(store, fn)
  }
}

async function resolveCtor(): Promise<ALSCtor | null> {
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
      return null
    }
  }
  return null
}

/**
 * Whether `ctor` actually isolates overlapping tasks.
 *
 * Constructor identity is not proof: a bundler's `AsyncLocalStorage`
 * shim on `globalThis` is typically a single slot, and trusting it
 * would disarm every fallback hardening while behaving exactly like
 * the fallback. So the claim is tested: two runs overlap across a
 * microtask and each must read back its own store. A ctor that throws
 * anywhere in the probe is answering the same question.
 */
async function isolates(ctor: ALSCtor): Promise<boolean> {
  try {
    const probe = new ctor<number>()
    const reads = await Promise.all([
      probe.run(1, async () => {
        await Promise.resolve()
        return probe.getStore()
      }),
      probe.run(2, async () => {
        await Promise.resolve()
        return probe.getStore()
      }),
    ])
    return reads[0] === 1 && reads[1] === 2
  } catch {
    return false
  }
}

const resolved = await resolveCtor()

/**
 * Whether the storage isolates concurrent tasks, verified behaviorally
 * at module load rather than assumed from where the constructor came
 * from.
 *
 * `AsyncLocalStorage` gives every task its own store. The fallback is
 * one frame stack whose top a concurrent task can shadow, so a caller
 * that binds a store for concurrent work has to know which it got.
 */
export const asyncContextIsolatesTasks: boolean = resolved !== null && (await isolates(resolved))

const verifiedCtor: ALSCtor | null = asyncContextIsolatesTasks ? resolved : null

const unbound: ContextCall | null = verifiedCtor?.snapshot?.() ?? null

/**
 * Run `fn` with no store bound, as this module loaded: for work a line
 * starts that outlives it and must not carry the line's state, such as
 * a sandbox's SFTP server. Without task isolation there is nothing to
 * leave, so `fn` runs as called.
 */
export function runDetached<R>(fn: () => R | Promise<R>): R | Promise<R> {
  return unbound === null ? fn() : unbound(fn)
}

export function createAsyncContext<T>(): AsyncStorage<T> {
  return verifiedCtor === null ? new FallbackStorage<T>() : new IsolatedStorage<T>(verifiedCtor)
}
