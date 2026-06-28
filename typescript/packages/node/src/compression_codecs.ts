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

interface Bzip2Module {
  compressFile(input: Uint8Array): Uint8Array
  decompressFile(input: Uint8Array): Uint8Array
}

interface XzModule {
  compress(input: Uint8Array): Promise<Uint8Array>
  decompress(input: Uint8Array): Promise<Uint8Array>
}

// compressjs and @napi-rs/lzma are CommonJS; load them via createRequire so
// the built ESM output resolves their exports without named-import interop
// pitfalls (mirrors the createRequire usage in workspace.ts).
const requireCjs = createRequire(import.meta.url)
const { Bzip2 } = requireCjs('compressjs') as { Bzip2: Bzip2Module }
const { xz } = requireCjs('@napi-rs/lzma') as { xz: XzModule }

registerCompressionCodec('bzip2', {
  compress: (bytes) => Promise.resolve(Uint8Array.from(Bzip2.compressFile(bytes))),
  decompress: (bytes) => Promise.resolve(Uint8Array.from(Bzip2.decompressFile(bytes))),
})

registerCompressionCodec('xz', {
  compress: async (bytes) => new Uint8Array(await xz.compress(Buffer.from(bytes))),
  decompress: async (bytes) => new Uint8Array(await xz.decompress(Buffer.from(bytes))),
})
