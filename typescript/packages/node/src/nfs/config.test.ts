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
  DEFAULT_HOST,
  DEFAULT_IDLE_FLUSH_SECONDS,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_PORT,
  NFSConfig,
} from './config.ts'

describe('NFSConfig', () => {
  it('binds loopback only by default', () => {
    // An NFSv3 export has no authentication of its own, so a default
    // that bound anywhere reachable would publish the workspace.
    const config = new NFSConfig()
    expect(config.host).toBe('127.0.0.1')
    expect(config.host).toBe(DEFAULT_HOST)
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.idleFlushSeconds).toBe(DEFAULT_IDLE_FLUSH_SECONDS)
    expect(config.maxBufferedBytes).toBe(DEFAULT_MAX_BUFFERED_BYTES)
  })

  it('allows port 0, which asks the OS to assign one', () => {
    expect(new NFSConfig({ port: 0 }).port).toBe(0)
  })

  it.each([-1, 65536, 1.5])('refuses port %s', (port) => {
    expect(() => new NFSConfig({ port })).toThrow(/port out of range/)
  })

  it.each([0, -1])('refuses a non-positive idle flush window (%s)', (idleFlushSeconds) => {
    expect(() => new NFSConfig({ idleFlushSeconds })).toThrow(/idleFlushSeconds/)
  })

  it('refuses a non-positive buffer ceiling', () => {
    expect(() => new NFSConfig({ maxBufferedBytes: 0 })).toThrow(/maxBufferedBytes/)
  })

  it('is frozen, the way python freezes its dataclass', () => {
    // `readonly` is compile-time only; the server is started from these
    // values, so a later write would describe a server that is not
    // running. Module code is strict, so the write throws.
    const config = new NFSConfig()
    expect(Object.isFrozen(config)).toBe(true)
    expect(() => {
      ;(config as unknown as { port: number }).port = 1234
    }).toThrow(TypeError)
    expect(config.port).toBe(DEFAULT_PORT)
  })

  it('defaults to a soft, bounded mount', () => {
    // The default has to be the survivable one: a hard mount blocks
    // every I/O forever when the server stops, and the server is the
    // process that set the mount up.
    const config = new NFSConfig()
    expect(config.soft).toBe(true)
    expect(config.timeo).toBe(50)
    expect(config.retrans).toBe(3)
    expect(config.deadTimeout).toBe(60)
  })

  it('can express a hard mount', () => {
    expect(new NFSConfig({ soft: false }).soft).toBe(false)
    expect(new NFSConfig({ deadTimeout: 0 }).deadTimeout).toBe(0)
  })

  it('refuses resilience knobs that describe no wait at all', () => {
    expect(() => new NFSConfig({ timeo: 0 })).toThrow(/timeo/)
    expect(() => new NFSConfig({ retrans: -1 })).toThrow(/retrans/)
    expect(() => new NFSConfig({ deadTimeout: -1 })).toThrow(/deadTimeout/)
  })
})
