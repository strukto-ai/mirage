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

from pathlib import Path

import pytest

from mirage.workspace.version.store import VersionStore


@pytest.mark.asyncio
async def test_open_creates_bare_repo(tmp_path: Path):
    store = await VersionStore.open(tmp_path / ".mirage")
    assert store is not None
    assert (tmp_path / ".mirage" / "objects").is_dir()
    assert (tmp_path / ".mirage" / "HEAD").is_file()


@pytest.mark.asyncio
async def test_open_reuses_existing_repo(tmp_path: Path):
    path = tmp_path / ".mirage"
    await VersionStore.open(path)
    reopened = await VersionStore.open(path)
    assert reopened is not None
