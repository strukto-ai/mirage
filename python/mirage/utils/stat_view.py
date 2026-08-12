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

from stat import S_IFDIR, S_IFREG

from mirage.types import FileStat, FileType
from mirage.utils.dates import iso_timestamp

# The one spelling of "a directory looks like drwxr-xr-x and a file
# like -rw-r--r--" for every stat translator (FUSE attrs, guest
# st_mode); mirrors utils/stat_view.ts.
DIR_MODE = S_IFDIR | 0o755
FILE_MODE = S_IFREG | 0o644


def mtime_ns(st: FileStat) -> int | None:
    """A FileStat's mtime as epoch nanoseconds, None when unknown.

    Delegates to ``iso_timestamp`` rather than re-parsing, which is the
    whole point: an offset-less stamp is read as UTC so every
    translator (FUSE, wasm, the TS bridge) answers the same epoch,
    instead of three of them drifting by the host's UTC offset. None
    (missing or unparseable stamp) is distinct from 0, which is the
    real answer for 1970-01-01T00:00:00Z; a wire with no validity
    channel collapses the two at its own boundary.

    Args:
        st (FileStat): the stat whose ``modified`` field to read.
    """
    seconds = iso_timestamp(st.modified)
    if seconds is None:
        return None
    return int(seconds * 1_000_000_000)


def is_dir(st: FileStat) -> bool:
    """Whether a FileStat describes a directory.

    Args:
        st (FileStat): the stat to inspect.
    """
    return st.type == FileType.DIRECTORY


def content_size(st: FileStat) -> int:
    """The byte size a stat consumer should report, 0 when unknown.

    A directory is always 0, whatever aggregate a backend put in
    ``size`` (Graph folders report a subtree total there); an unknown
    file size is 0 and rides the unknown-size machinery above.

    Args:
        st (FileStat): the stat to inspect.
    """
    if is_dir(st):
        return 0
    return st.size or 0
