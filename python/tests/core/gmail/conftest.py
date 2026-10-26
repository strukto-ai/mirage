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

import pytest

from mirage.policy.builtin.output_cap import ALL_COMMANDS
from mirage.types import FileStat, Limit, MountMode, PathSpec
from mirage.vfs.gmail.config import GmailConfig
from mirage.vfs.gmail.gmail import GmailVFS
from mirage.workspace import Workspace
from tests.fixtures.gmail_api import FakeGmail
from tests.fixtures.google_api import install_api


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


@pytest.fixture
def gmail(monkeypatch):
    """Run a line over a Gmail mount served by a ``FakeGmail``.

    Returns:
        an async ``run(line, fake=None, walk_limit=None, **config)`` giving
        the output, the exit code, the message ids read and the queries
        searched; ``walk_limit`` is the mount's ``"*"`` command limit.
    """

    async def run(
        line: str,
        fake: FakeGmail | None = None,
        walk_limit: int | None = None,
        **config: Any,
    ):
        fake = fake or FakeGmail()
        install_api(monkeypatch, gmail=fake)
        settings = {"access_token": "t"} | config
        vfs = CountingGmail(GmailConfig(**settings))
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
        return out, result.exit_code, sorted(vfs.reads), fake.searches

    return run
