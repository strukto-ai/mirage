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

from mirage.commands.builtin.filetype_factory import make_filetype_commands
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.builtin.sharepoint._provision import \
    file_read_provision as _ft_provision
from mirage.commands.builtin.sharepoint.du import du
from mirage.core.sharepoint.copy import copy as _copy
from mirage.core.sharepoint.create import create as _create
from mirage.core.sharepoint.du import du as _du
from mirage.core.sharepoint.du import du_all as _du_all
from mirage.core.sharepoint.exists import exists as _exists
from mirage.core.sharepoint.find import find as _find
from mirage.core.sharepoint.glob import resolve_glob as _ft_resolve_glob
from mirage.core.sharepoint.mkdir import mkdir as _mkdir
from mirage.core.sharepoint.read import read_bytes as _read
from mirage.core.sharepoint.readdir import readdir as _readdir
from mirage.core.sharepoint.rename import rename as _rename
from mirage.core.sharepoint.rm import rm_r as _rm_r
from mirage.core.sharepoint.rmdir import rmdir as _rmdir
from mirage.core.sharepoint.stat import stat as _stat
from mirage.core.sharepoint.stream import read_stream as _read_stream
from mirage.core.sharepoint.truncate import truncate as _truncate
from mirage.core.sharepoint.unlink import unlink as _unlink
from mirage.core.sharepoint.write import write_bytes as _write

# SharePoint files are read and written through the generic factory (with
# filetype commands for columnar files); du keeps a wrapper because its
# du_all returns a flat list (du_multi contract)
# rather than the generic (list, total) tuple, matching OneDrive. Folder copy
# is server-side via the dir_copy field.
_SHAREPOINT_CMD_OPS = CommandIO(
    readdir=_readdir,
    read_bytes=_read,
    read_stream=_read_stream,
    stat=_stat,
    is_mounted=lambda a: True,
    local=False,
    write=_write,
    exists=_exists,
    mkdir=_mkdir,
    unlink=_unlink,
    rmdir=_rmdir,
    rm_r=_rm_r,
    rename=_rename,
    copy=_copy,
    dir_copy=_copy,
    create=_create,
    truncate=_truncate,
    find=_find,
    du_total=_du,
    du_all=_du_all,
)

_SHAREPOINT_OVERRIDES = {"du"}

COMMANDS = [
    *make_filetype_commands(
        "sharepoint", _ft_resolve_glob, _read, provision=_ft_provision),
    *make_generic_commands(
        "sharepoint",
        _SHAREPOINT_CMD_OPS,
        overrides=_SHAREPOINT_OVERRIDES,
    ),
    du,
]
