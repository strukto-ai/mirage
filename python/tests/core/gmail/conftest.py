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

from typing import Any

import pytest_asyncio

from mirage.policy.builtin.output_cap import ALL_COMMANDS
from mirage.types import FileStat, Limit, MountMode, PathSpec
from mirage.vfs.gmail.config import GmailConfig
from mirage.vfs.gmail.gmail import GmailVFS
from mirage.workspace import Workspace
from tests.fixtures.gmail_seed import seed
from tests.fixtures.google_account import MESSAGES, GoogleAccount


class CountingGmail(GmailVFS):
    """A Gmail mount recording the id of each message file it reads."""

    def __init__(self, config: GmailConfig) -> None:
        super().__init__(config)
        self.reads: list[str] = []

    async def read(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> bytes:
        if path.vfs_path.endswith(".gmail.json"):
            self.reads.append(
                path.vfs_path.rsplit("__", 1)[-1].removesuffix(".gmail.json")
            )
        return await super().read(path, entry)


@pytest_asyncio.fixture
async def gmail(google_account: GoogleAccount):
    """Run a line over a Gmail mount on the fake, its mailbox the seeded
    ``MAILBOX``.

    Returns:
        an async ``run(line, walk_limit=None, **config)`` giving the
        output, the exit code, the keys of the messages read and the
        queries searched; ``walk_limit`` is the mount's ``"*"`` command
        limit.
    """
    keys = await seed(google_account)

    async def run(line: str, walk_limit: int | None = None, **config: Any):
        await google_account.run.record_requests()
        vfs = CountingGmail(google_account.config(GmailConfig, **config))
        limits = (
            {}
            if walk_limit is None
            else {ALL_COMMANDS: Limit(walk_limit=walk_limit)}
        )
        ws = Workspace(
            {"/gmail": (vfs, MountMode.READ, limits)}, mode=MountMode.READ
        )
        try:
            result = await ws.shell(line)
            out = await result.stdout_str()
        finally:
            await ws.close()
        # A date window is asked as after:, so a search is any other query.
        searches = [
            asked["q"]
            for asked in await google_account.run.params("GET", MESSAGES)
            if "q" in asked and not asked["q"].startswith("after:")
        ]
        read = sorted(keys[message_id] for message_id in vfs.reads)
        return out, result.exit_code, read, searches

    return run
