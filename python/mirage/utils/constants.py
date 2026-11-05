# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

# The longest session id, profile name or workspace id a caller may give:
# each is a store key and a URL segment, and room for a UUID with a prefix.
MAX_NAME_LENGTH = 128

TIMESTAMP_BITS = 48
TIMESTAMP_MASK = (1 << TIMESTAMP_BITS) - 1
# rand_a carries the intra-millisecond counter (RFC 9562 section 6.2,
# "fixed-length dedicated counter"). Seeded well below its maximum so a
# burst has room to climb without rolling over, which is what the RFC
# asks for, while still starting unpredictably.
COUNTER_MAX = (1 << 12) - 1
COUNTER_SEED_BITS = 8
RANDOM_BITS = 62
# Written into the layout by hand: uuid.UUID's own `version` argument
# refuses anything above 5 until Python 3.14.
UUID_VERSION = 7
UUID_VARIANT = 0b10

MAX_SEED = (1 << 53) - 1
WORD_BITS = 32
WORD_MASK = (1 << WORD_BITS) - 1
WORDS_AHEAD = 1024
SPLITMIX_GAMMA = 0x9E3779B97F4A7C15
SPLITMIX_MUL1 = 0xBF58476D1CE4E5B9
SPLITMIX_MUL2 = 0x94D049BB133111EB
UINT64_MASK = (1 << 64) - 1
