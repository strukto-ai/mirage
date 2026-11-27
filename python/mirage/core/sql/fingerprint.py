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


def token_of(ino: int, seconds: int, nanoseconds: int) -> str:
    """A file's fingerprint: its inode and the time its last write landed
    at, to the nanosecond.

    Every write lands past the time the database gave the write before
    (``now_stamp``), so a rewrite always moves it, a same-size one in the
    same instant included; the inode tells a file renamed over the name
    from the one it replaced.

    Args:
        ino (int): the file's inode.
        seconds (int): its ``mtime``.
        nanoseconds (int): its ``mtime_nsec``.
    """
    return f"{ino}:{seconds}.{nanoseconds:09d}"
