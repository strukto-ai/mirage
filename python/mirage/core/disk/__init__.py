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

from mirage.core.disk.copy import copy
from mirage.core.disk.create import create
from mirage.core.disk.du import entries as du_entries
from mirage.core.disk.du import size as du_size
from mirage.core.disk.exists import exists
from mirage.core.disk.find import find
from mirage.core.disk.mkdir import mkdir
from mirage.core.disk.read import read_bytes, read_range
from mirage.core.disk.readdir import readdir
from mirage.core.disk.rename import rename
from mirage.core.disk.rm import rm_r
from mirage.core.disk.rmdir import rmdir
from mirage.core.disk.stat import stat
from mirage.core.disk.stream import read_stream
from mirage.core.disk.truncate import truncate
from mirage.core.disk.unlink import unlink
from mirage.core.disk.write import write_bytes

__all__ = [
    "copy",
    "create",
    "du_size",
    "du_entries",
    "exists",
    "find",
    "mkdir",
    "read_bytes",
    "read_range",
    "read_stream",
    "readdir",
    "rename",
    "rm_r",
    "rmdir",
    "stat",
    "truncate",
    "unlink",
    "write_bytes",
]
