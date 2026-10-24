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

import pytest

from mirage.core.gridfs import client, driver, events, read, stream
from tests.fixtures.gridfs_store import FakeStore


@pytest.fixture
def store(monkeypatch) -> FakeStore:
    """One in-memory bucket behind every module that reaches GridFS."""
    fake = FakeStore()
    for module in (client, driver, read, stream, events):
        globs = vars(module)
        for name in ("files_coll", "chunks_coll", "bucket"):
            if name in globs:
                monkeypatch.setitem(globs, name, lambda accessor: fake)
    return fake
