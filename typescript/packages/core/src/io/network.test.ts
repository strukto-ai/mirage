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
import {
  mergeRoutes,
  NetworkRule,
  networkBound,
  networkLayer,
  networkLets,
  networkRoute,
  networkRoutes,
  networkRule,
  runWithNetwork,
  sameNetwork,
  type NetworkSetting,
} from './network.ts'

describe('sameNetwork', () => {
  it.each<[NetworkSetting, NetworkSetting, boolean]>([
    [true, true, true],
    [false, { allowed_domains: [] }, true],
    [
      { allowed_domains: ['a.com', 'b.com'] },
      { allowed_domains: ['b.com', 'a.com', 'a.com'] },
      true,
    ],
    [true, { allowed_domains: [] }, false],
    [{ allowed_domains: ['a.com'] }, { allowed_domains: ['b.com'] }, false],
    [{ allowed_domains: ['10.0.0.5'] }, { allowed_domains: ['10.0.0.5.'] }, false],
    [{ denied_domains: ['a.com'] }, { allowed_domains: ['a.com'] }, false],
    [true, { denied_domains: [] }, true],
    [{ allowed_domains: ['a.com'] }, { allowed_domains: ['a.com'], denied_domains: [] }, true],
    [
      { allowed_domains: ['*'], denied_domains: ['b.com', 'a.com'] },
      { denied_domains: ['a.com', 'b.com'], allowed_domains: ['*'] },
      true,
    ],
    [true, { routes: {} }, true],
    [
      { routes: { 'a.com:80': '10.0.0.1:8080' } },
      { routes: { 'A.com.:80': '10.0.0.1:8080' } },
      true,
    ],
    [
      { routes: { 'a.com:80': '10.0.0.1:8080' } },
      { routes: { 'a.com:80': '10.0.0.1:8081' } },
      false,
    ],
    [{ routes: { 'a.com:80': '10.0.0.1:8080' } }, true, false],
  ])('%o and %o: %s', (a, b, same) => {
    expect(sameNetwork(a, b)).toBe(same)
  })
})

describe('networkLayer', () => {
  it.each<[NetworkSetting, Record<string, unknown> | null]>([
    [true, null],
    [false, { allow: [] }],
    [{ allowed_domains: ['a.com'] }, { allow: ['a.com'] }],
    [{ denied_domains: ['*:22'] }, { deny: ['*:22'] }],
    [
      { allowed_domains: ['*'], denied_domains: ['evil.test'] },
      { allow: ['*'], deny: ['evil.test'] },
    ],
    [{ routes: { 'a.com:80': '10.0.0.1:8080' } }, null],
    [{ allowed_domains: ['a.com'], routes: {} }, { allow: ['a.com'] }],
  ])('adds the layer of %o', (setting, layer) => {
    expect(networkLayer(setting)).toEqual(layer)
  })

  it.each([
    'off',
    {},
    { allow: ['a.com'] },
    { deny: ['a.com'] },
    { allowed_domains: 'a.com' },
    { routes: ['a.com:80'] },
    { routes: { 'a.com:80': 8080 } },
  ])('refuses %o', (setting) => {
    expect(() => networkLayer(setting)).toThrow(/network is true, false or/)
  })
})

describe('NetworkRule', () => {
  it('refuses a bad entry', () => {
    expect(() => new NetworkRule([{ allow: ['10.0.0.0/33'] }])).toThrow(
      /is not an address, a range/,
    )
  })

  it('routes a host and port to the end it names', () => {
    const rule = new NetworkRule([], false, {
      'localhost:5003': '127.0.0.1:61001',
      'Svc.Test.:80': '[::1]:8080',
      '[::1]:22': 'jump.test:2222',
    })
    expect(rule.route('localhost', 5003)).toEqual(['127.0.0.1', 61001])
    expect(rule.route('LOCALHOST.', 5003)).toEqual(['127.0.0.1', 61001])
    expect(rule.route('localhost', 5004)).toBeNull()
    expect(rule.route('svc.test', 80)).toEqual(['::1', 8080])
    expect(rule.route('[::1]', 22)).toEqual(['jump.test', 2222])
    expect(rule.route('::1', 22)).toEqual(['jump.test', 2222])
  })

  it.each([
    [{ localhost: '127.0.0.1:1' }, /route "localhost" is not host:port/],
    [{ 'localhost:5003': '127.0.0.1' }, /route "127.0.0.1" is not host:port/],
    [{ 'localhost:0': '127.0.0.1:1' }, /is not host:port/],
    [{ 'localhost:65536': '127.0.0.1:1' }, /is not host:port/],
    [{ '::1:80': '127.0.0.1:1' }, /is not host:port/],
    [{ 'a.test:80': '127.0.0.1:1', 'A.test.:80': '127.0.0.1:2' }, /name the same end/],
    [
      { 'a.test:80': 'b.test:80', 'B.test:80': 'c.test:80' },
      /goes to b.test:80, which is routed too/,
    ],
  ])('refuses the routes %o', (routes, message) => {
    expect(() => new NetworkRule([], false, routes)).toThrow(message)
  })

  it('routes over others in place of each spelling of their end', () => {
    const base = { 'LOCALHOST.:5003': '127.0.0.1:1', 'a.test:80': '127.0.0.1:2' }
    expect(mergeRoutes(base, { 'localhost:5003': '127.0.0.1:3' })).toEqual({
      'a.test:80': '127.0.0.1:2',
      'localhost:5003': '127.0.0.1:3',
    })
  })

  it('is built for routes alone, which the bound call answers by', async () => {
    const setting = { routes: { 'localhost:5003': '127.0.0.1:61001' } }
    expect(networkRoutes(setting)).toEqual(setting.routes)
    expect(networkRoutes(false)).toEqual({})
    const rule = networkRule(setting)
    expect(rule?.layers).toEqual([])
    expect(networkRule({ routes: {} })).toBeNull()
    expect(networkRoute('localhost', 5003)).toBeNull()
    expect(
      await runWithNetwork(rule, () => Promise.resolve(networkRoute('localhost', 5003))),
    ).toEqual(['127.0.0.1', 61001])
  })

  it('holds only the call it is bound to', async () => {
    const rule = new NetworkRule([{ allow: ['*.github.com'] }])
    const asked = await runWithNetwork(rule, () => {
      expect(networkBound()).toBe(rule)
      return Promise.resolve([
        networkLets('api.github.com', '140.82.112.6'),
        networkLets('', '127.0.0.1'),
      ])
    })
    expect(asked).toEqual([true, false])
    expect(networkBound()).toBeNull()
    expect(networkLets('', '127.0.0.1')).toBe(true)
  })
})
