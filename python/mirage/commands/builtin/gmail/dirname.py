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

from mirage.accessor.gmail import GmailAccessor
from mirage.commands.builtin.generic.dirname import dirname as generic_dirname
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("dirname", resource="gmail", spec=SPECS["dirname"])
async def dirname(
    accessor: GmailAccessor,
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    return await generic_dirname(*texts)
