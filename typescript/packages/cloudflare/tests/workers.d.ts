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

// The part of the Durable Object API the test worker's object is built on.
declare module 'cloudflare:workers' {
  interface Storage {
    readonly sql: {
      exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] }
    }
    transactionSync<T>(fn: () => T): T
  }

  export class DurableObject<Env = unknown> {
    constructor(ctx: { readonly storage: Storage }, env: Env)
    protected readonly ctx: { readonly storage: Storage }
    protected readonly env: Env
  }
}
