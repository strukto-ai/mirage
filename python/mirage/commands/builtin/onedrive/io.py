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

from mirage.core.generic.du import make_walked_du
from mirage.core.onedrive.copy import copy as _copy
from mirage.core.onedrive.create import create as _create
from mirage.core.onedrive.exists import exists as _exists
from mirage.core.onedrive.find import find as _find
from mirage.core.onedrive.mkdir import mkdir as _mkdir
from mirage.core.onedrive.read import read as _read
from mirage.core.onedrive.readdir import readdir as _readdir
from mirage.core.onedrive.rename import rename as _rename
from mirage.core.onedrive.rm import rm_r as _rm_r
from mirage.core.onedrive.rmdir import rmdir as _rmdir
from mirage.core.onedrive.stat import stat as _stat
from mirage.core.onedrive.stream import read_stream as _read_stream
from mirage.core.onedrive.truncate import truncate as _truncate
from mirage.core.onedrive.unlink import unlink as _unlink
from mirage.core.onedrive.write import write as _write
from mirage.vfs.adapter import VFSAdapter
from mirage.vfs.types import NativeReadOps, ReadOps, WriteOps

IO = VFSAdapter(
    read=ReadOps(readdir=_readdir, read_bytes=_read, stat=_stat),
    native=NativeReadOps(
        read_range=_read,
        read_stream=_read_stream,
        exists=_exists,
        find=_find,
        du=make_walked_du(_stat, _readdir),
    ),
    writes=WriteOps(
        write=_write,
        mkdir=_mkdir,
        unlink=_unlink,
        rmdir=_rmdir,
        rm_r=_rm_r,
        rename=_rename,
        copy=_copy,
        dir_copy=_copy,
        create=_create,
        truncate=_truncate,
    ),
    is_mounted=lambda a: True,
    local=False,
).to_command_io()
