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

from mirage.resources.memory import memory_resource_store
from mirage.resources.types import EntryInput
from mirage.secrets.config import SecretRef
from mirage.server.resources.strukto import with_entries


@pytest.mark.asyncio
async def test_a_plain_field_keeps_its_type_and_a_sealed_one_is_read():
    store = memory_resource_store()
    await store.create_entry(
        "vfs",
        EntryInput(
            name="db",
            type="postgres",
            fields={"schemas": ["public", "analytics"]},
            sealed={"password": "pw"},
        ),
    )
    schemas = {"from": "strukto", "ref": "db", "key": "schemas"}
    password = {"from": "strukto", "ref": "db", "key": "password"}
    written = {
        "mounts": {
            "/db": {
                "vfs": "postgres",
                "config": {"schemas": schemas, "password": password},
            }
        }
    }
    config = await with_entries(store, written, ["db"])
    mount = config.mounts["/db"].config
    assert mount["schemas"] == ["public", "analytics"]
    assert SecretRef.model_validate(mount["password"]).key == "password"
    assert config.secrets is not None
    assert config.secrets["strukto"].config == {
        "entries": {"db": {"password": "pw"}}
    }
