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

import { openStreamSync, type OpenStream } from '../rs/stream.ts'
import { toHex } from './hex.ts'

export type DigestAlgorithm = 'md5' | 'sha1' | 'sha256'

/** Incremental shared digest. Finalizing or closing releases its Wasm handle. */
export class Digest {
  private readonly stream: OpenStream

  constructor(algorithm: DigestAlgorithm) {
    this.stream = openStreamSync('digest', { algorithm })
  }

  update(bytes: Uint8Array): void {
    this.stream.feed(bytes)
  }

  digest(): string {
    try {
      return new TextDecoder().decode(this.stream.finish())
    } finally {
      this.close()
    }
  }

  close(): void {
    this.stream.close()
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return toHex(new Uint8Array(digest))
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined') {
    const digest = await crypto.subtle.digest('SHA-1', bytes as BufferSource)
    return toHex(new Uint8Array(digest))
  }
  return yieldingDigest('sha1', bytes)
}

export function md5Hex(bytes: Uint8Array): string {
  const hash = new Digest('md5')
  try {
    hash.update(bytes)
    return hash.digest()
  } finally {
    hash.close()
  }
}

export async function md5HexAsync(bytes: Uint8Array): Promise<string> {
  return yieldingDigest('md5', bytes)
}

async function yieldingDigest(algorithm: DigestAlgorithm, bytes: Uint8Array): Promise<string> {
  const hash = new Digest(algorithm)
  try {
    const step = 1024 * 1024
    for (let offset = 0; offset < bytes.byteLength; offset += step) {
      hash.update(bytes.subarray(offset, offset + step))
      if (offset + step < bytes.byteLength)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    return hash.digest()
  } finally {
    hash.close()
  }
}
