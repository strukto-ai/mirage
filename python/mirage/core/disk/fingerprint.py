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

import os

from mirage.utils.dates import settled


def token_of(st: os.stat_result, now_ns: int) -> str | None:
    """An entry's fingerprint, from its stat: a file's bytes, or the
    names a folder lists.

    Every write to a file and every add, rename or remove inside a folder
    moves the entry's change time, so the stat covers both. The inode and
    device catch an entry made again or a filesystem mounted over it; the
    mtime covers a platform whose ``st_ctime`` is a creation time. An entry
    that has not ``settled`` gets none, since a second change within one
    timestamp tick would leave every one of those numbers where it was.

    Args:
        st (os.stat_result): the entry's stat, links followed.
        now_ns (int): the wall clock, read before the stat.

    Returns:
        str | None: ``dev:ino:ctime_ns:mtime_ns``, or None while the
            entry is still settling.
    """
    if not settled(max(st.st_ctime_ns, st.st_mtime_ns), now_ns):
        return None
    return f"{st.st_dev}:{st.st_ino}:{st.st_ctime_ns}:{st.st_mtime_ns}"
