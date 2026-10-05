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

from mirage.core.hf_buckets.create import create as _create
from mirage.core.hf_buckets.du import entries as _du_entries
from mirage.core.hf_buckets.du import size as _du_size
from mirage.core.hf_buckets.exists import exists as _exists
from mirage.core.hf_buckets.find import find as _find
from mirage.core.hf_buckets.mkdir import mkdir as _mkdir
from mirage.core.hf_buckets.read import read as _read
from mirage.core.hf_buckets.readdir import readdir as _readdir
from mirage.core.hf_buckets.rm import rm_r as _rm_r
from mirage.core.hf_buckets.stat import stat as _stat
from mirage.core.hf_buckets.stream import read_stream as _read_stream
from mirage.core.hf_buckets.unlink import unlink as _unlink
from mirage.core.hf_buckets.write import write as _write
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.types import DuOps, NativeReadOps, ReadOps, WriteOps

# Hugging Face bucket files are read and written through the generic factory;
# rather than the generic (list, total) tuple.
# Copy falls back to reads and writes; there is no native copy/rename op.
IO = VFSAdapter(
    read=ReadOps(readdir=_readdir, read_bytes=_read, stat=_stat),
    native=NativeReadOps(
        read_range=_read,
        read_stream=_read_stream,
        exists=_exists,
        find=_find,
        du=DuOps(size=_du_size, entries=_du_entries),
    ),
    writes=WriteOps(
        write=_write, mkdir=_mkdir, unlink=_unlink, rm_r=_rm_r, create=_create
    ),
    is_mounted=lambda a: True,
    local=False,
).to_command_io()
