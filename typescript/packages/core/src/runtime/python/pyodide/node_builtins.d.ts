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

// The Node builtins core reaches for, declared with only the members
// it uses, rather than depending on `@types/node`.
//
// Core has to work in both runtimes, and pulling the whole Node surface in
// would let any module here use `node:fs` and still typecheck — the rule
// would survive only in review. Whatever is used has to be written down
// here first, which is a small price for a compiler-enforced boundary.
//
// These imports run only on Node paths. Worker sealing additionally checks
// for registerHooks before changing the realm; its filesystem access only
// canonicalizes package paths. Other Node behavior belongs in packages/node.

declare module 'node:module' {
  export const registerHooks:
    | ((hooks: { resolve: (specifier: string) => never }) => void)
    | undefined
  export function createRequire(url: string): {
    resolve(id: string): string
  }
}

declare module 'node:path' {
  export function dirname(p: string): string
  export function resolve(...paths: string[]): string
  export function relative(from: string, to: string): string
  export function isAbsolute(path: string): boolean
  export const sep: string
}

declare module 'node:fs/promises' {
  export function realpath(path: string): Promise<string>
}

declare module 'node:worker_threads' {
  export class Worker {
    constructor(source: string | URL, options?: { eval?: boolean; execArgv?: string[] })
    postMessage(value: unknown): void
    on<T>(event: 'message', receive: (message: T) => void): void
    on(event: 'error' | 'messageerror', receive: (error: Error) => void): void
    on(event: 'exit', receive: (code: number) => void): void
    terminate(): Promise<number>
    unref(): void
  }
  export const parentPort: {
    postMessage(value: unknown): void
    on<T>(event: 'message', receive: (message: T) => void): void
  } | null
}
