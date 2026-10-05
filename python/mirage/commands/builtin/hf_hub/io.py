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

from mirage.core.hf_hub.constants import SCOPE_ERROR
from mirage.core.hf_hub.exists import exists as _exists
from mirage.core.hf_hub.read import read as _read
from mirage.core.hf_hub.readdir import readdir as _readdir
from mirage.core.hf_hub.stat import stat as _stat
from mirage.core.hf_hub.stream import read_stream as _read_stream
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.types import NativeReadOps, ReadOps

# No native find or du op, and that is not an omission. Those exist to
# spare an API tree one request per directory, and this mount has no such
# cost: the Hub's listing is recursive, so one paged fetch is the whole
# tree and every readdir under the generic walk is a dictionary lookup
# against it. A native walk here would buy a constant factor and cost a
# second implementation of the same traversal.
#
# The mount is read-only, and the byte-mutation ops are absent the way
# github's are. A Hub write is a COMMIT: `write_bytes` commits one file
# under one canned message, so `cp -r` over fifty files would leave fifty
# commits rather than one changeset. A POSIX write cannot say where a
# commit ends, so the filesystem is the wrong verb for this backend and
# the `hf` CLI is the right one: `hf upload` batches every file of one
# invocation into a single commit carrying the message the line gave it.
# That is the same split github and `git` already draw, and it is why cp
# and mv are absent too rather than synthesized from read-then-commit.
#
# The writable copy is a LOCAL mount, and that is the workflow rather than
# a workaround: `hf download --local-dir /work` writes into a ram or disk
# mount, which is an ordinary writable filesystem, so the files are edited
# there with ordinary commands and `hf upload /work/f path` sends one
# commit back. Pinned end to end by
# `hf_a_local_mount_is_the_writable_copy` in integ/cli/hf.json.
IO = VFSAdapter(
    read=ReadOps(readdir=_readdir, read_bytes=_read, stat=_stat),
    native=NativeReadOps(
        read_range=_read, read_stream=_read_stream, exists=_exists
    ),
    is_mounted=lambda a: True,
    local=False,
    max_glob_matches=SCOPE_ERROR,
).to_command_io()
