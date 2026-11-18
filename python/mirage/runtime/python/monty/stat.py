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

from stat import S_IFDIR, S_IFMT, S_IFREG
from typing import Any

from mirage.runtime.python.monty.loader import load_monty_module
from mirage.runtime.types import VFSEntry, VFSStat


def file_type(st: VFSStat | VFSEntry) -> int:
    """Use the row's declared POSIX type, falling back for permission-only modes."""
    return S_IFMT(st.mode or 0) or (S_IFDIR if st.is_dir else S_IFREG)


def is_regular_row(st: VFSStat | VFSEntry) -> bool:
    return file_type(st) == S_IFREG


def is_dir_row(st: VFSStat | VFSEntry) -> bool:
    return file_type(st) == S_IFDIR


def stat_result(st: VFSStat) -> Any:
    # Monty reads a 0.0 as epoch zero rather than substituting the host
    # clock, so an unknown mtime stays unknown instead of becoming now.
    mtime = (st.mtime_ns or 0) / 1_000_000_000
    stat = load_monty_module().StatResult
    if is_dir_row(st):
        return stat.dir_stat(mode=st.mode, mtime=mtime)
    return stat.file_stat(size=st.size, mode=st.mode, mtime=mtime)
