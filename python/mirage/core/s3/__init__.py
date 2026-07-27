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

from mirage.core.s3.copy import copy
from mirage.core.s3.create import create
from mirage.core.s3.du import entries as du_entries
from mirage.core.s3.du import size as du_size
from mirage.core.s3.exists import exists
from mirage.core.s3.find import find
from mirage.core.s3.mkdir import mkdir
from mirage.core.s3.read import read_bytes
from mirage.core.s3.readdir import readdir
from mirage.core.s3.rename import rename
from mirage.core.s3.rm import rm_r
from mirage.core.s3.rmdir import rmdir
from mirage.core.s3.stat import stat
from mirage.core.s3.stream import range_read, read_stream
from mirage.core.s3.truncate import truncate
from mirage.core.s3.unlink import unlink
from mirage.core.s3.write import write_bytes

__all__ = [
    "copy",
    "create",
    "du_size",
    "du_entries",
    "exists",
    "find",
    "mkdir",
    "range_read",
    "read_bytes",
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
