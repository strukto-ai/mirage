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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.core.google.entry import resolve_app_entry
from mirage.core.gsheets.constants import MIME
from mirage.core.gsheets.scope import detect_scope
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.observe.context import record, start_op
from mirage.types import FileStat, PathSpec
from mirage.vfs.gsheets.sheet_entry import make_filename


async def _read_file(
    accessor: GSheetsAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    row = entry or await resolve_app_entry(
        accessor.drive, match, path, MIME, make_filename
    )
    timer = start_op()
    data = await accessor.sheets.read_spreadsheet(match.slots["file_id"])
    record(
        "read",
        path.virtual,
        "gsheets",
        len(data),
        timer,
        fingerprint=row.fingerprint,
    )
    return data


read = make_read(detect_scope, readers={"file": _read_file})
