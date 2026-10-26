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

import hashlib
import json
import math
import random

Key = str | int


def u64(seed: int, *key: Key) -> int:
    """A 64-bit draw that depends only on ``seed`` and ``key``.

    Keyed, not streamed: a request added elsewhere shifts no other draw,
    so a pinned seed keeps most of its schedule across unrelated changes.

    Args:
        seed (int): the run's seed.
        key (Key): what is drawn for, e.g. ("latency", "a", 3, "f").
    """
    encoded = json.dumps([seed, *key], separators=(",", ":")).encode()
    digest = hashlib.blake2b(encoded, digest_size=8).digest()
    return int.from_bytes(digest, "big")


def uniform(seed: int, *key: Key) -> float:
    """``u64`` scaled to [0, 1).

    Args:
        seed (int): the run's seed.
        key (Key): what is drawn for.
    """
    return u64(seed, *key) / 2**64


def exponential(seed: int, mean: float, *key: Key) -> float:
    """An exponential draw with ``mean``, by inverse transform.

    Args:
        seed (int): the run's seed.
        mean (float): the mean, in virtual seconds.
        key (Key): what is drawn for.
    """
    return -mean * math.log1p(-uniform(seed, *key))


def stream(seed: int, *key: Key) -> random.Random:
    """A private ``random.Random`` for one actor's own choices.

    Args:
        seed (int): the run's seed.
        key (Key): whose stream, e.g. ("actor", "a").
    """
    return random.Random(u64(seed, *key))
