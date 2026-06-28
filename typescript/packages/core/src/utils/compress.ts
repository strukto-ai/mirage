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

async function runThrough(
  bytes: Uint8Array,
  transform: GenericTransformStream,
): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart])
  const piped = blob.stream().pipeThrough(transform)
  const buf = await new Response(piped).arrayBuffer()
  return new Uint8Array(buf)
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new CompressionStream('gzip'))
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new DecompressionStream('gzip'))
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new CompressionStream('deflate-raw'))
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return runThrough(bytes, new DecompressionStream('deflate-raw'))
}

export interface CompressionCodec {
  compress(bytes: Uint8Array): Promise<Uint8Array>
  decompress(bytes: Uint8Array): Promise<Uint8Array>
}

const codecs = new Map<string, CompressionCodec>()

// gzip ships in every runtime via CompressionStream; heavier codecs (bzip2,
// xz) are registered by the runtime package that bundles a dependency for
// them. Browser core leaves them unregistered, so tar -j/-J report
// "not supported" there.
export function registerCompressionCodec(name: string, codec: CompressionCodec): void {
  codecs.set(name, codec)
}

export function getCompressionCodec(name: string): CompressionCodec | undefined {
  return codecs.get(name)
}
