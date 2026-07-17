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

import { v7 as uuidV7 } from 'uuid'

/**
 * Mint an RFC 9562 UUIDv7 in canonical lowercase hyphenated form.
 *
 * The first 48 bits are a unix-millisecond timestamp, so ids sort by
 * creation time and stay index-friendly as database primary keys; the
 * remaining 74 bits are random.
 */
export function uuid7(): string {
  return uuidV7()
}

/** Mint a fresh workspace id (UUIDv7). */
export function newWorkspaceId(): string {
  return uuid7()
}

/** Mint a fresh session id (UUIDv7). */
export function newSessionId(): string {
  return uuid7()
}
