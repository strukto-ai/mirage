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

import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import type { Resource } from '../resource/base.ts'
import type { PathSpec } from '../types.ts'
import { enotsup, type MissingOpError } from '../utils/errors.ts'

export interface OpKwargs {
  index?: IndexCacheStore
  filetype?: string | null
  [k: string]: unknown
}

export type OpFn = (
  accessor: Accessor,
  path: PathSpec,
  args: readonly unknown[],
  kwargs: OpKwargs,
) => unknown

/* eslint-disable @typescript-eslint/no-invalid-void-type */
export interface RegisteredOp {
  name: string
  resource: string | null
  filetype: string | null
  fn(
    this: void,
    accessor: Accessor,
    path: PathSpec,
    args: readonly unknown[],
    kwargs: OpKwargs,
  ): unknown
  write: boolean
}
/* eslint-enable @typescript-eslint/no-invalid-void-type */

export interface OpOptions {
  resource: string | string[]
  filetype?: string | null
  write?: boolean
}

const REGISTERED_OPS = Symbol.for('@struktoai/mirage-core.registeredOps')

interface OpCarrier {
  [REGISTERED_OPS]?: RegisteredOp[]
}

export function op(name: string, options: OpOptions) {
  return function methodDecorator(target: OpFn, _context: ClassMethodDecoratorContext): void {
    const resources = Array.isArray(options.resource) ? options.resource : [options.resource]
    const carrier = target as OpFn & OpCarrier
    let list = carrier[REGISTERED_OPS]
    if (!list) {
      list = []
      carrier[REGISTERED_OPS] = list
    }
    for (const r of resources) {
      list.push({
        name,
        resource: r,
        filetype: options.filetype ?? null,
        fn: target,
        write: options.write ?? false,
      })
    }
  }
}

export class OpsRegistry {
  private readonly registered = new Map<string, RegisteredOp>()
  private readonly owners = new Map<string, Resource>()
  private readonly scoped = new WeakMap<Resource, Map<string, RegisteredOp>>()

  register(ro: RegisteredOp): void {
    const key = keyFor(ro.name, ro.filetype, ro.resource)
    this.registered.set(key, ro)
    this.owners.delete(key)
  }

  unregisterResource(resourceKind: string | Resource): void {
    for (const [key, ro] of this.registered) {
      if (
        typeof resourceKind === 'string'
          ? ro.resource === resourceKind
          : this.owners.get(key) === resourceKind
      ) {
        this.registered.delete(key)
        this.owners.delete(key)
      }
    }
  }

  registerResource(resource: Resource, overwrite = true): void {
    const entries = this.collectResource(resource)
    this.scoped.set(resource, entries)
    for (const [key, ro] of entries) {
      if (!overwrite && this.registered.has(key)) continue
      this.register(ro)
      if (this.registered.get(key) === ro) this.owners.set(key, resource)
    }
  }

  private collectResource(resource: Resource): Map<string, RegisteredOp> {
    const entries = new Map<string, RegisteredOp>()
    const chain: object[] = []
    let proto = Object.getPrototypeOf(resource) as object | null
    while (proto !== null && proto !== Object.prototype) {
      chain.push(proto)
      proto = Object.getPrototypeOf(proto) as object | null
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const p = chain[i]
      if (p === undefined) continue
      for (const key of Object.getOwnPropertyNames(p)) {
        if (key === 'constructor') continue
        const method: unknown = Object.getOwnPropertyDescriptor(p, key)?.value
        if (typeof method !== 'function') continue
        const carrier = method as OpFn & OpCarrier
        const ops = carrier[REGISTERED_OPS]
        if (!ops) continue
        const bound = method.bind(resource) as OpFn
        for (const ro of ops) {
          entries.set(keyFor(ro.name, ro.filetype, ro.resource), { ...ro, fn: bound })
        }
      }
    }
    for (const ro of resource.ops?.() ?? []) {
      entries.set(keyFor(ro.name, ro.filetype, ro.resource), ro)
    }
    return entries
  }

  private entry(key: string, resource: Resource | null): RegisteredOp | null {
    const registered = this.registered.get(key)
    if (registered === undefined) return null
    // Explicit registry overrides and removals remain authoritative.
    if (resource === null || !this.owners.has(key)) return registered
    let entries = this.scoped.get(resource)
    if (entries === undefined) {
      entries = this.collectResource(resource)
      this.scoped.set(resource, entries)
    }
    // An instance-bound operation from a sibling mount is never a fallback.
    return entries.get(key) ?? null
  }

  find(
    name: string,
    resource: string | Resource | null,
    filetype: string | null = null,
  ): RegisteredOp | null {
    const owner = typeof resource === 'object' ? resource : null
    const kind = typeof resource === 'object' ? (resource?.kind ?? null) : resource
    return this.entry(keyFor(name, filetype, kind), owner)
  }

  resolve(name: string, resource: string, filetype: string | null = null): OpFn {
    if (filetype !== null) {
      const specific = this.registered.get(keyFor(name, filetype, resource))
      if (specific) return specific.fn
    }
    const byResource = this.registered.get(keyFor(name, null, resource))
    if (byResource) return byResource.fn
    const global = this.registered.get(keyFor(name, null, null))
    if (global) return global.fn
    // No operand here; stamp code + op so callers can still test for the
    // capability gap by type instead of message text.
    const err = new Error(`no op registered: ${name} for resource ${resource}`) as MissingOpError
    err.code = 'ENOTSUP'
    err.op = name
    throw err
  }

  async call(
    name: string,
    resourceKind: string | Resource,
    accessor: Accessor,
    path: PathSpec,
    args: readonly unknown[] = [],
    kwargs: OpKwargs = {},
  ): Promise<unknown> {
    const filetype = kwargs.filetype ?? null
    const owner = typeof resourceKind === 'string' ? null : resourceKind
    const kind = typeof resourceKind === 'string' ? resourceKind : resourceKind.kind
    const levels: OpFn[] = []
    if (filetype !== null) {
      const specific = this.entry(keyFor(name, filetype, kind), owner)
      if (specific) levels.push(specific.fn)
    }
    const byResource = this.entry(keyFor(name, null, kind), owner)
    if (byResource) levels.push(byResource.fn)
    const global = this.entry(keyFor(name, null, null), owner)
    if (global) levels.push(global.fn)

    if (levels.length === 0) {
      throw enotsup(kind, name, path)
    }

    for (const fn of levels) {
      const result = await fn(accessor, path, args, kwargs)
      if (result !== null && result !== undefined) {
        return result
      }
    }
    return null
  }
}

export function registerOp(
  registry: OpsRegistry,
  name: string,
  fn: OpFn,
  options: OpOptions,
): void {
  const resources = Array.isArray(options.resource) ? options.resource : [options.resource]
  const filetype = options.filetype ?? null
  const write = options.write ?? false
  for (const r of resources) {
    registry.register({ name, resource: r, filetype, fn, write })
  }
}

function keyFor(name: string, filetype: string | null, resource: string | null): string {
  return `${name}\u0000${filetype ?? ''}\u0000${resource ?? ''}`
}
