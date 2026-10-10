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

from mirage.runtime.stat import PosixStat


def stat_result(st: PosixStat) -> os.stat_result:
    """One `os.stat_result`, every field resolved.

    Every optional field is filled explicitly, because built from a
    plain 10-tuple they come back None while still answering
    ``hasattr``: ``shutil.copystat`` reads ``st_flags`` that way and
    handed the host's chflags a None, and ``pathlib`` reads the
    ``_ns`` pair. A key the platform has no such field for
    (``st_flags`` off BSD) is dropped by the constructor, so the
    result carries exactly what a real stat there would.

    Args:
        st (PosixStat): the stat the shared rule computed for the path.
    """
    atime = st.atime_ns / 1_000_000_000
    mtime = st.mtime_ns / 1_000_000_000
    ctime = st.ctime_ns / 1_000_000_000
    return os.stat_result(
        (
            st.mode,
            st.ino,
            st.dev,
            st.nlink,
            st.uid,
            st.gid,
            st.size,
            int(atime),
            int(mtime),
            int(ctime),
        ),
        {
            "st_atime": atime,
            "st_mtime": mtime,
            "st_ctime": ctime,
            "st_atime_ns": st.atime_ns,
            "st_mtime_ns": st.mtime_ns,
            "st_ctime_ns": st.ctime_ns,
            "st_birthtime": mtime,
            "st_blksize": st.blksize,
            "st_blocks": st.blocks,
            "st_rdev": st.rdev,
            "st_flags": 0,
            "st_gen": 0,
        },
    )
