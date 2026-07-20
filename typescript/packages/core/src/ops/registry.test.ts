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

import { describe, expect, it } from 'vitest'
import type { Accessor } from '../accessor/base.ts'
import { NOOPAccessor } from '../accessor/base.ts'
import type { Resource } from '../resource/base.ts'
import { PathSpec } from '../types.ts'
import { op, OpsRegistry, registerOp } from './registry.ts'

const stubAccessor: Accessor = new NOOPAccessor()
const stubPath = PathSpec.fromStrPath('/x')

describe('@op decorator', () => {
  it('accepts a single resource string', () => {
    class R {
      @op('read', { resource: 'ram' })
      async read(_a: Accessor, _p: PathSpec): Promise<string> {
        return Promise.resolve('hello')
      }
    }
    const registry = new OpsRegistry()
    registry.registerResource(new R() as unknown as Resource)
    const fn = registry.resolve('read', 'ram')
    expect(fn).toBeDefined()
  })

  it('accepts an array of resources and registers once per entry', async () => {
    class R {
      @op('read', { resource: ['ram', 'disk'] })
      async read(_a: Accessor, _p: PathSpec): Promise<string> {
        return Promise.resolve('multi')
      }
    }
    const registry = new OpsRegistry()
    registry.registerResource(new R() as unknown as Resource)
    const ramFn = registry.resolve('read', 'ram')
    const diskFn = registry.resolve('read', 'disk')
    await expect(ramFn(stubAccessor, stubPath, [], {})).resolves.toBe('multi')
    await expect(diskFn(stubAccessor, stubPath, [], {})).resolves.toBe('multi')
  })

  it('defaults filetype to null and write to false', () => {
    class R {
      @op('stat', { resource: 'ram' })
      async stat(_a: Accessor, _p: PathSpec): Promise<number> {
        return Promise.resolve(1)
      }
    }
    const registry = new OpsRegistry()
    registry.registerResource(new R() as unknown as Resource)
    const ro = registry.find('stat', 'ram')
    expect(ro?.filetype).toBeNull()
    expect(ro?.write).toBe(false)
  })

  it('passes through filetype and write when provided', () => {
    class R {
      @op('parse', { resource: 'ram', filetype: 'json', write: false })
      async parse(_a: Accessor, _p: PathSpec): Promise<unknown> {
        return Promise.resolve(null)
      }
      @op('write', { resource: 'ram', write: true })
      async doWrite(_a: Accessor, _p: PathSpec): Promise<void> {
        return Promise.resolve()
      }
    }
    const registry = new OpsRegistry()
    registry.registerResource(new R() as unknown as Resource)
    expect(registry.find('parse', 'ram', 'json')?.filetype).toBe('json')
    expect(registry.find('write', 'ram')?.write).toBe(true)
  })
})

describe('OpsRegistry.registerResource', () => {
  it('binds registered methods to the instance so `this` works', async () => {
    class R {
      readonly label = 'ram-store'
      @op('label', { resource: 'ram' })
      async getLabel(_a: Accessor, _p: PathSpec): Promise<string> {
        return Promise.resolve(this.label)
      }
    }
    const registry = new OpsRegistry()
    registry.registerResource(new R() as unknown as Resource)
    const fn = registry.resolve('label', 'ram')
    await expect(fn(stubAccessor, stubPath, [], {})).resolves.toBe('ram-store')
  })

  it('walks the prototype chain — subclass methods win over parent', async () => {
    class Base {
      @op('greet', { resource: 'ram' })
      async greet(_a: Accessor, _p: PathSpec): Promise<string> {
        return Promise.resolve('base')
      }
    }
    class Child extends Base {
      @op('greet', { resource: 'ram' })
      override async greet(_a: Accessor, _p: PathSpec): Promise<string> {
        return Promise.resolve('child')
      }
    }
    const registry = new OpsRegistry()
    registry.registerResource(new Child() as unknown as Resource)
    const fn = registry.resolve('greet', 'ram')
    await expect(fn(stubAccessor, stubPath, [], {})).resolves.toBe('child')
  })
})

describe('OpsRegistry.register (imperative)', () => {
  it('stores a RegisteredOp by (name, filetype, resource)', () => {
    const registry = new OpsRegistry()
    registry.register({
      name: 'read',
      resource: 'ram',
      filetype: null,
      fn: () => 'x',
      write: false,
    })
    expect(registry.find('read', 'ram')).toBeDefined()
  })

  it('overwrites an existing entry with the same key', () => {
    const registry = new OpsRegistry()
    registry.register({
      name: 'read',
      resource: 'ram',
      filetype: null,
      fn: () => 'first',
      write: false,
    })
    registry.register({
      name: 'read',
      resource: 'ram',
      filetype: null,
      fn: () => 'second',
      write: false,
    })
    const fn = registry.resolve('read', 'ram')
    expect(fn(stubAccessor, stubPath, [], {})).toBe('second')
  })
})

describe('OpsRegistry.resolve fallback chain', () => {
  it('prefers filetype-specific match when filetype is given', () => {
    const registry = new OpsRegistry()
    registry.register({
      name: 'read',
      resource: 'ram',
      filetype: null,
      fn: () => 'default',
      write: false,
    })
    registry.register({
      name: 'read',
      resource: 'ram',
      filetype: 'json',
      fn: () => 'json-specific',
      write: false,
    })
    const fn = registry.resolve('read', 'ram', 'json')
    expect(fn(stubAccessor, stubPath, [], {})).toBe('json-specific')
  })

  it('falls back to resource-only when filetype-specific missing', () => {
    const registry = new OpsRegistry()
    registry.register({
      name: 'read',
      resource: 'ram',
      filetype: null,
      fn: () => 'resource-default',
      write: false,
    })
    const fn = registry.resolve('read', 'ram', 'yaml')
    expect(fn(stubAccessor, stubPath, [], {})).toBe('resource-default')
  })

  it('falls back to global (resource=null) when resource-specific missing', () => {
    const registry = new OpsRegistry()
    registry.register({
      name: 'echo',
      resource: null,
      filetype: null,
      fn: () => 'global',
      write: false,
    })
    const fn = registry.resolve('echo', 'ram')
    expect(fn(stubAccessor, stubPath, [], {})).toBe('global')
  })

  it('throws when nothing matches', () => {
    const registry = new OpsRegistry()
    expect(() => registry.resolve('nope', 'ram')).toThrow(/no op registered/)
  })

  it('stamps the missing-op error with ENOTSUP and the op name', () => {
    const registry = new OpsRegistry()
    let caught: unknown
    try {
      registry.resolve('nope', 'ram')
    } catch (err) {
      caught = err
    }
    expect(caught).toMatchObject({ code: 'ENOTSUP', op: 'nope' })
  })
})

describe('OpsRegistry.call', () => {
  it('awaits async ops and returns the value', async () => {
    const registry = new OpsRegistry()
    registry.register({
      name: 'read',
      resource: 'ram',
      filetype: null,
      fn: async () => Promise.resolve('async-value'),
      write: false,
    })
    await expect(registry.call('read', 'ram', stubAccessor, stubPath)).resolves.toBe('async-value')
  })

  it('walks fallback: first non-null result wins', async () => {
    const registry = new OpsRegistry()
    registry.register({
      name: 'read',
      resource: 'ram',
      filetype: 'json',
      fn: () => null,
      write: false,
    })
    registry.register({
      name: 'read',
      resource: 'ram',
      filetype: null,
      fn: () => 'from-resource-default',
      write: false,
    })
    const result = await registry.call('read', 'ram', stubAccessor, stubPath, [], {
      filetype: 'json',
    })
    expect(result).toBe('from-resource-default')
  })

  it('throws when nothing matches', async () => {
    const registry = new OpsRegistry()
    await expect(registry.call('nope', 'ram', stubAccessor, stubPath)).rejects.toThrow(
      /no op registered/,
    )
  })

  it('stamps ENOTSUP, the op name and the operand on the missing-op error', async () => {
    const registry = new OpsRegistry()
    await expect(registry.call('nope', 'ram', stubAccessor, stubPath)).rejects.toMatchObject({
      code: 'ENOTSUP',
      op: 'nope',
      virtualPath: '/x',
    })
  })
})

describe('registerOp helper', () => {
  it('adds an op to the target registry', () => {
    const registry = new OpsRegistry()
    registerOp(registry, 'echo', () => 'hello', { resource: 'ram' })
    const fn = registry.resolve('echo', 'ram')
    expect(fn(stubAccessor, stubPath, [], {})).toBe('hello')
  })

  it('registers one entry per resource when given an array', () => {
    const registry = new OpsRegistry()
    registerOp(registry, 'cat', () => 'multi', { resource: ['ram', 'disk', 's3'] })
    expect(registry.resolve('cat', 'ram')(stubAccessor, stubPath, [], {})).toBe('multi')
    expect(registry.resolve('cat', 'disk')(stubAccessor, stubPath, [], {})).toBe('multi')
    expect(registry.resolve('cat', 's3')(stubAccessor, stubPath, [], {})).toBe('multi')
  })
})
