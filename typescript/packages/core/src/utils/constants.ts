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

// The longest session id, profile name or workspace id a caller may give:
// each is a store key and a URL segment, and room for a UUID with a prefix.
export const MAX_NAME_LENGTH = 128

export const MAX_SEED = Number.MAX_SAFE_INTEGER
export const WORD_BITS = 32
export const WORD_MASK = 0xffffffff
export const WORDS_AHEAD = 1024
export const TIMESTAMP_BITS = 48n
export const TIMESTAMP_MASK = (1n << TIMESTAMP_BITS) - 1n
// rand_a carries the intra-millisecond counter (RFC 9562 section 6.2), seeded
// well below its maximum so a burst has room to climb, as ids.py does.
export const COUNTER_MAX = 0xfff
export const COUNTER_SEED_BITS = 8
export const RANDOM_BITS = 62
export const UUID_VERSION = 7n
export const UUID_VARIANT = 0b10n
export const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n
export const SPLITMIX_MUL1 = 0xbf58476d1ce4e5b9n
export const SPLITMIX_MUL2 = 0x94d049bb133111ebn
export const UINT64_MASK = (1n << 64n) - 1n
