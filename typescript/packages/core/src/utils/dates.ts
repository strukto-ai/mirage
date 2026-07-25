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

export function utcDateFolder(ts?: number): string {
  const d = ts === undefined ? new Date() : new Date(ts)
  return d.toISOString().slice(0, 10)
}

// Truncated to whole seconds so this matches the Python epoch_to_iso byte
// for byte (second precision).
export function epochToIso(seconds: number): string {
  return new Date(Math.floor(seconds) * 1000).toISOString().replace('.000Z', 'Z')
}

// Inverse of epochToIso; a naive stamp (no Z/offset, e.g. a `touch -t`
// overlay time) is read as UTC so this matches the Python isoToEpoch. JS
// interprets an offset-less date-time as local, so append Z when absent.
// Truncated to whole seconds to mirror epochToIso.
export function isoToEpoch(iso: string): number {
  const text = /(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`
  return Math.floor(Date.parse(text) / 1000)
}
