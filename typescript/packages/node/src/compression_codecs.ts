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
import { Readable, type Duplex } from 'node:stream'
import { registerCompressionCodec } from '@struktoai/mirage-core/utils/compress'
import { materialize } from '@struktoai/mirage-core/io/types'
import { chunks } from '@struktoai/mirage-core/io/cooperative'

interface XzModule {
  createCompressStream(): Duplex
  createDecompressStream(): Duplex
}

const requireCjs = createRequire(import.meta.url)
const bunzip = requireCjs('unbzip2-stream') as () => Duplex
const xz = requireCjs('@napi-rs/lzma/xz') as XzModule

async function* transform(
  source: AsyncIterable<Uint8Array>,
  codec: Duplex,
): AsyncGenerator<Uint8Array> {
  const stream = Readable.from(chunks(source)).compose(codec) as Readable
  try {
    yield* chunks(stream as AsyncIterable<Uint8Array>)
  } finally {
    stream.destroy()
  }
}

// The permissively licensed bzip2 codec decodes only.
registerCompressionCodec('bzip2', {
  decompress: (bytes) => materialize(transform(chunks(bytes), bunzip())),
  decompressStream: (source) => transform(source, bunzip()),
})

registerCompressionCodec('xz', {
  compress: (bytes) => materialize(transform(chunks(bytes), xz.createCompressStream())),
  decompress: (bytes) => materialize(transform(chunks(bytes), xz.createDecompressStream())),
  compressStream: (source) => transform(source, xz.createCompressStream()),
  decompressStream: (source) => transform(source, xz.createDecompressStream()),
})
