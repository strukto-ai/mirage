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

import { toHex } from './hex.ts'

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return new Uint8Array(digest)
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await sha256(bytes))
}

async function subtleHex(algo: AlgorithmIdentifier, bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algo, bytes as BufferSource)
  return toHex(new Uint8Array(digest))
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  if (typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined')
    return subtleHex('SHA-1', bytes)
  const hash = new Sha1()
  // Match md5HexAsync's yielding budget on hosts without native hashing.
  const step = 1024 * 1024
  for (let offset = 0; offset < bytes.byteLength; offset += step) {
    hash.update(bytes.subarray(offset, offset + step))
    if (offset + step < bytes.byteLength)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return hash.digest()
}

/**
 * The 8-byte SHA-1 length trailer: the message length in bits, big-endian
 * across 64 bits. Split into high and low words, since the bit length passes
 * 32 bits at 512 MiB and a 32-bit shift would wrap it. Exported so its test
 * can cross that boundary without hashing 512 MiB.
 */
export function sha1LengthTrailer(byteLength: number): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint32(0, Math.floor(byteLength / 0x20000000) >>> 0)
  view.setUint32(4, (byteLength * 8) >>> 0)
  return out
}

/**
 * Incremental SHA-1, for bytes that arrive in chunks. WebCrypto hashes only
 * a whole buffer, and a stream cannot be buffered whole to hash at the end:
 * drains are bounded, so the copy would be unbounded and never cached. The
 * partial block a chunk leaves is carried into the next `update`; padding
 * happens only in `digest`.
 */
export class Sha1 {
  private readonly state = new Uint32Array([
    0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0,
  ])
  private readonly block = new Uint8Array(64)
  private readonly words = new Uint32Array(80)
  private filled = 0
  private length = 0

  update(chunk: Uint8Array): void {
    this.length += chunk.byteLength
    let at = 0
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, chunk.byteLength)
      this.block.set(chunk.subarray(0, take), this.filled)
      this.filled += take
      at = take
      if (this.filled < 64) return
      this.compress(this.block, 0)
      this.filled = 0
    }
    for (; at + 64 <= chunk.byteLength; at += 64) this.compress(chunk, at)
    if (at < chunk.byteLength) {
      this.block.set(chunk.subarray(at))
      this.filled = chunk.byteLength - at
    }
  }

  digest(): string {
    const pad = (this.filled < 56 ? 56 : 120) - this.filled
    const tail = new Uint8Array(this.filled + pad + 8)
    tail.set(this.block.subarray(0, this.filled))
    tail[this.filled] = 0x80
    tail.set(sha1LengthTrailer(this.length), tail.length - 8)
    const state = Uint32Array.from(this.state)
    for (let off = 0; off < tail.length; off += 64) this.compress(tail, off, state)
    const out = new Uint8Array(20)
    const view = new DataView(out.buffer)
    for (let i = 0; i < 5; i++) view.setUint32(i * 4, state[i] ?? 0)
    return toHex(out)
  }

  private compress(bytes: Uint8Array, off: number, state: Uint32Array = this.state): void {
    const w = this.words
    const view = new DataView(bytes.buffer, bytes.byteOffset + off, 64)
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4)
    for (let i = 16; i < 80; i++) {
      w[i] = rotl((w[i - 3] ?? 0) ^ (w[i - 8] ?? 0) ^ (w[i - 14] ?? 0) ^ (w[i - 16] ?? 0), 1)
    }
    let a = state[0] ?? 0
    let b = state[1] ?? 0
    let c = state[2] ?? 0
    let d = state[3] ?? 0
    let e = state[4] ?? 0
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const t = (rotl(a, 5) + f + e + k + (w[i] ?? 0)) >>> 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = t
    }
    state[0] = ((state[0] ?? 0) + a) >>> 0
    state[1] = ((state[1] ?? 0) + b) >>> 0
    state[2] = ((state[2] ?? 0) + c) >>> 0
    state[3] = ((state[3] ?? 0) + d) >>> 0
    state[4] = ((state[4] ?? 0) + e) >>> 0
  }
}

export async function sha384Hex(bytes: Uint8Array): Promise<string> {
  return subtleHex('SHA-384', bytes)
}

export async function sha512Hex(bytes: Uint8Array): Promise<string> {
  return subtleHex('SHA-512', bytes)
}

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0
}

function* md5Blocks(bytes: Uint8Array): Generator<void, Uint8Array> {
  const len = bytes.byteLength
  const bitLen = len * 8
  const padLen = (len % 64 < 56 ? 56 : 120) - (len % 64)
  const total = len + padLen + 8
  const fullLength = len - (len % 64)
  const tail = new Uint8Array(total - fullLength)
  tail.set(bytes.subarray(fullLength))
  tail[len - fullLength] = 0x80
  const tailView = new DataView(tail.buffer)
  tailView.setUint32(tail.length - 8, bitLen >>> 0, true)
  tailView.setUint32(tail.length - 4, Math.floor(bitLen / 0x100000000) >>> 0, true)
  const inputView = new DataView(bytes.buffer, bytes.byteOffset, fullLength)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  const M = new Uint32Array(16)
  for (let off = 0; off < total; off += 64) {
    if (off > 0 && off % 16384 === 0) yield
    const view = off < fullLength ? inputView : tailView
    const base = off < fullLength ? off : off - fullLength
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(base + j * 4, true)
    let A = a0
    let B = b0
    let C = c0
    let D = d0
    for (let i = 0; i < 64; i++) {
      let F: number
      let g: number
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      F = (F + A + (K[i] ?? 0) + (M[g] ?? 0)) >>> 0
      A = D
      D = C
      C = B
      B = (B + rotl(F, S[i] ?? 0)) >>> 0
    }
    a0 = (a0 + A) >>> 0
    b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0
    d0 = (d0 + D) >>> 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0, true)
  outView.setUint32(4, b0, true)
  outView.setUint32(8, c0, true)
  outView.setUint32(12, d0, true)
  return out
}

export function md5Hex(bytes: Uint8Array): string {
  const blocks = md5Blocks(bytes)
  let result = blocks.next()
  while (!result.done) result = blocks.next()
  return toHex(result.value)
}

// The yielding twin of md5Hex, for hashing bytes a caller just received.
// This is pure-JS MD5 (WebCrypto has none, and core cannot import
// node:crypto), so one long hash would block the loop a TypeScript FUSE mount
// is served from. md5Blocks yields once per 16 KiB, so this hands the loop
// back about every MiB.
const MD5_SLICES_PER_YIELD = 64

export async function md5HexAsync(bytes: Uint8Array): Promise<string> {
  const blocks = md5Blocks(bytes)
  let result = blocks.next()
  let sinceYield = 0
  while (!result.done) {
    result = blocks.next()
    sinceYield += 1
    if (sinceYield >= MD5_SLICES_PER_YIELD) {
      sinceYield = 0
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  }
  return toHex(result.value)
}
