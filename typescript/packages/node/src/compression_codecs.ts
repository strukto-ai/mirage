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

import { createRequire } from 'node:module'
import { registerCompressionCodec } from '@struktoai/mirage-core'

interface BunzipModule {
  decode(input: Uint8Array): Uint8Array
}

interface XzModule {
  compress(input: Uint8Array): Promise<Uint8Array>
  decompress(input: Uint8Array): Promise<Uint8Array>
}

// seek-bzip and @napi-rs/lzma are CommonJS; load them via createRequire so
// the built ESM output resolves their exports without named-import interop
// pitfalls (mirrors the createRequire usage in workspace.ts).
const requireCjs = createRequire(import.meta.url)
const bunzip = requireCjs('seek-bzip') as BunzipModule
const { xz } = requireCjs('@napi-rs/lzma') as { xz: XzModule }

// bzip2 is decompress-only on purpose: seek-bzip is the maintained
// permissively licensed implementation and it only decodes, so `tar -cj`
// reports unsupported while `-xj` / `-tj` work. The pure-JS compressor that
// used to sit here (compressjs) is GPL, which an Apache-2.0 package cannot
// ship.
registerCompressionCodec('bzip2', {
  decompress: (bytes) => Promise.resolve(Uint8Array.from(bunzip.decode(bytes))),
})

registerCompressionCodec('xz', {
  compress: async (bytes) => new Uint8Array(await xz.compress(Buffer.from(bytes))),
  decompress: async (bytes) => new Uint8Array(await xz.decompress(Buffer.from(bytes))),
})
