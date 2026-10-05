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

from mirage.core.ram.append import append_bytes as _append
from mirage.core.ram.constants import SCOPE_ERROR
from mirage.core.ram.copy import copy as _copy
from mirage.core.ram.create import create as _create
from mirage.core.ram.du import entries as _du_entries
from mirage.core.ram.du import size as _du_size
from mirage.core.ram.exists import exists as _exists
from mirage.core.ram.find import find as _find
from mirage.core.ram.mkdir import mkdir as _mkdir
from mirage.core.ram.pwrite import pwrite as _pwrite
from mirage.core.ram.read import read as _read
from mirage.core.ram.readdir import readdir as _readdir
from mirage.core.ram.rename import rename as _rename
from mirage.core.ram.rm import rm_r as _rm_r
from mirage.core.ram.rmdir import rmdir as _rmdir
from mirage.core.ram.set_attrs import set_attrs as _set_attrs
from mirage.core.ram.stat import stat as _stat
from mirage.core.ram.stream import read_stream as _read_stream
from mirage.core.ram.truncate import truncate as _truncate
from mirage.core.ram.unlink import unlink as _unlink
from mirage.core.ram.write import write as _write
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.types import DuOps, NativeReadOps, ReadOps, WriteOps

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
        write=_write,
        mkdir=_mkdir,
        unlink=_unlink,
        rmdir=_rmdir,
        rm_r=_rm_r,
        rename=_rename,
        copy=_copy,
        create=_create,
        append=_append,
        pwrite=_pwrite,
        set_attrs=_set_attrs,
        truncate=_truncate,
    ),
    is_mounted=lambda a: a.store is not None,
    local=True,
    max_glob_matches=SCOPE_ERROR,
).to_command_io()
