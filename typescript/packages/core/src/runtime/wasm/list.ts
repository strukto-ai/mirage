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

/**
 * Encode one fd_readdir entry; d_next and d_ino are the entry's index + 1.
 *
 * @param index - zero-based position of the entry in the listing.
 * @param name - the entry's name, already encoded.
 * @param filetype - preview1 filetype, FT_UNKNOWN when not known.
 */
export function packDirent(index: number, name: Uint8Array, filetype: number): Uint8Array {
  const record = new Uint8Array(24 + name.byteLength)
  const view = new DataView(record.buffer)
  view.setBigUint64(0, BigInt(index + 1), true)
  view.setBigUint64(8, BigInt(index + 1), true)
  view.setUint32(16, name.byteLength, true)
  view.setUint8(20, filetype)
  record.set(name, 24)
  return record
}
