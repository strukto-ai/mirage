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

from mirage.types import FileStat, MountMode, PathSpec
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
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
        entry: FileStat | None = None,
    ) -> bytes:
        if path.vfs_path.endswith(".gmail.json"):
            self.reads.append(
                path.vfs_path.rsplit("__", 1)[-1].removesuffix(".gmail.json")
            )
        return await super().read(path, offset, size, entry)


@pytest.fixture
def gmail(monkeypatch):
    """Run a line over a Gmail mount served by a ``FakeGmail``.

    Returns:
        an async ``run(line, fake=None, **config)`` giving the output, the
        exit code, the message ids read and the queries searched.
    """

    async def run(line: str, fake: FakeGmail | None = None, **config: Any):
        fake = fake or FakeGmail()
        install_api(monkeypatch, gmail=fake)
        settings = {"access_token": "t", "content_search": True} | config
        vfs = CountingGmail(GmailConfig(**settings))
        ws = Workspace({"/gmail": vfs}, mode=MountMode.READ)
        try:
            result = await ws.shell(line)
            out = await result.stdout_str()
        finally:
            await ws.close()
        return out, result.exit_code, sorted(vfs.reads), fake.searches

    return run
