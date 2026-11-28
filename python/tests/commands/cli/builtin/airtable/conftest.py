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

from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest_asyncio

from mirage import Workspace
from mirage.commands.cli.builtin.airtable import AIRTABLE
from mirage.core.airtable.config import AirtableConfig
from mirage.types import MountMode
from mirage.vfs.airtable import AirtableVFS
from mirage.vfs.ram import RAMVFS
from tests.fixtures.airtable_account import AirtableAccount, airtable_account

__all__ = ["airtable_account", "airtable_ws"]


@pytest_asyncio.fixture
async def airtable_ws(
    airtable_account: AirtableAccount,
) -> AsyncIterator[Callable[..., Workspace]]:
    """Open workspaces with the CLI installed beside a mount of the fake.

    Both read the same account on the integ fake, ``/at`` the mount and
    ``/s`` a scratch RAM tree, so a case can compare the CLI's bytes
    with the file's.
    """
    opened: list[Workspace] = []

    def make(**overrides: Any) -> Workspace:
        config = airtable_account.fields(**overrides)
        ws = Workspace(
            {
                "/at/": (
                    AirtableVFS(AirtableConfig(**config)),
                    MountMode.READ,
                ),
                "/s/": RAMVFS(),
            },
            mode=MountMode.WRITE,
        )
        ws.register_cli("airtable", AIRTABLE, config)
        opened.append(ws)
        return ws

    yield make
    for ws in opened:
        await ws.close()
