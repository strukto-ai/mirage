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

# Logical major:minor for the synthetic devices, the canonical Linux
# numbers so `stat`, `ls -l`, `file` and tar render GNU-like output. They
# are VFS identifiers, not a platform FUSE rdev.
DEV_RDEV: dict[str, tuple[int, int]] = {
    "null": (1, 3),
    "random": (1, 8),
    "tty": (5, 0),
    "urandom": (1, 9),
    "zero": (1, 5),
}

# The devices that read endless random bytes and swallow writes, as
# Linux's random and urandom do.
RANDOM_DEVICES = frozenset({"random", "urandom"})

# The controlling terminal, which a shell run with none, as `bash -c` from
# an agent is, cannot open: a read or a write of it is ENXIO.
TTY = "tty"

# The chunk /dev/zero yields per step of an unbounded stream. It is a
# streaming granularity, never a total: the device is endless and a
# command safeguard, not this constant, bounds it.
ZERO_CHUNK_SIZE = 1 << 20
