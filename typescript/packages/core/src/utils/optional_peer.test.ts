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
import { loadOptionalPeer, missingPeer } from './optional_peer.ts'

const CONFIG = {
  feature: 'FUSE support',
  packageName: '@zkochan/fuse-native',
  docsUrl: 'https://mirage.dev/typescript/setup/fuse',
}

const HINT = 'FUSE also needs an OS driver: macFUSE on macOS.'

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('loadOptionalPeer', () => {
  it('returns what the importer resolves to', async () => {
    const mod = { default: 'ctor' }
    expect(await loadOptionalPeer(() => Promise.resolve(mod), CONFIG)).toBe(mod)
  })

  it('names the package to install when it does not resolve', async () => {
    const err = withCode("Cannot find package '@zkochan/fuse-native'", 'ERR_MODULE_NOT_FOUND')
    await expect(loadOptionalPeer(() => Promise.reject(err), CONFIG)).rejects.toThrow(
      /pnpm add @zkochan\/fuse-native/,
    )
  })

  // A native peer dlopens its system library while it loads, so the driver
  // being absent is a load failure, not a resolution failure. Reporting
  // "install the package" there sends the reader after the wrong thing.
  it('rethrows a load failure untouched with no systemHint', async () => {
    const err = withCode('dlopen(fuse.node): Library not loaded', 'ERR_DLOPEN_FAILED')
    await expect(loadOptionalPeer(() => Promise.reject(err), CONFIG)).rejects.toBe(err)
  })

  it('reports the driver to install when a systemHint says which', async () => {
    const err = withCode('dlopen(fuse.node): Library not loaded', 'ERR_DLOPEN_FAILED')
    const load = loadOptionalPeer(() => Promise.reject(err), { ...CONFIG, systemHint: HINT })
    await expect(load).rejects.toThrow(/macFUSE on macOS/)
    await expect(load).rejects.toThrow(/Library not loaded/)
    await expect(load).rejects.toHaveProperty('cause', err)
  })

  it('keeps a codeless load failure, such as a missing prebuild', async () => {
    const err = new Error('No native build was found for platform=darwin')
    await expect(loadOptionalPeer(() => Promise.reject(err), CONFIG)).rejects.toBe(err)
    const load = loadOptionalPeer(() => Promise.reject(err), { ...CONFIG, systemHint: HINT })
    await expect(load).rejects.toThrow(/No native build was found/)
    await expect(load).rejects.toThrow(/macFUSE on macOS/)
  })
})

describe('missingPeer', () => {
  it("answers an import's own catch as loadOptionalPeer does", async () => {
    const err = withCode("Cannot find package '@zkochan/fuse-native'", 'ERR_MODULE_NOT_FOUND')
    await expect(Promise.reject(err).catch(missingPeer(CONFIG))).rejects.toThrow(
      /pnpm add @zkochan\/fuse-native/,
    )
    const load = withCode('dlopen(fuse.node): Library not loaded', 'ERR_DLOPEN_FAILED')
    await expect(Promise.reject(load).catch(missingPeer(CONFIG))).rejects.toBe(load)
  })
})
