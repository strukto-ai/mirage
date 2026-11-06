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


import stat

import pytest

from mirage.resources.errors import ResourceError
from mirage.resources.types import EntryInput, TemplateInput
from mirage.server.resources.files import files_resource_store


@pytest.mark.asyncio
async def test_sealed_values_live_apart_in_owner_only_files(tmp_path):
    store = files_resource_store(tmp_path)
    await store.create_entry(
        "cli", EntryInput("gh", "gh", {"a": 1}, {"token": "secret-x"})
    )
    sealed = tmp_path / ".sealed" / "cli" / "gh.json"
    assert stat.S_IMODE(sealed.stat().st_mode) == 0o600
    assert stat.S_IMODE(sealed.parent.stat().st_mode) == 0o700
    assert "secret-x" not in (tmp_path / "cli" / "gh.yaml").read_text()
    again = files_resource_store(tmp_path)
    assert (await again.reveal_entry("cli", "gh")).sealed == {
        "token": "secret-x"
    }


@pytest.mark.asyncio
async def test_a_string_reads_back_as_a_string(tmp_path):
    config = {"mounts": {"/": {"vfs": "ram", "mode": "off", "ttl": "1e3"}}}
    await files_resource_store(tmp_path).put_template(
        TemplateInput(name="t", config=config)
    )
    saved = await files_resource_store(tmp_path).get_template("t")
    assert saved.config == config


@pytest.mark.asyncio
async def test_a_hand_edited_file_reads_as_yaml_or_refuses(tmp_path):
    store = files_resource_store(tmp_path)
    (tmp_path / "policy").mkdir()
    (tmp_path / "policy" / "a.py.yaml").write_text("name: a.py\nsource: x\n")
    assert (await store.get_policy("a.py")).source == "x"
    (tmp_path / "policy" / "c.py.yaml").write_text("{source: allow}\n")
    assert (await store.get_policy("c.py")).source == "allow"
    (tmp_path / "policy" / "b.py.yaml").write_text("source: [\n")
    with pytest.raises(ResourceError) as broken:
        await store.get_policy("b.py")
    assert broken.value.code == "invalid"


@pytest.mark.asyncio
async def test_records_are_owner_only(tmp_path):
    await files_resource_store(tmp_path).put_template(
        TemplateInput(name="t", config={"env": {"TOKEN": "x"}})
    )
    record = tmp_path / "template" / "t.yaml"
    assert stat.S_IMODE(record.stat().st_mode) == 0o600
    assert stat.S_IMODE(record.parent.stat().st_mode) == 0o700


@pytest.mark.asyncio
async def test_a_hand_edited_date_stays_a_string(tmp_path):
    store = files_resource_store(tmp_path)
    (tmp_path / "template").mkdir()
    (tmp_path / "template" / "t.yaml").write_text(
        "name: t\nconfig: {since: 2020-01-01}\n"
    )
    assert (await store.get_template("t")).config == {"since": "2020-01-01"}
    await store.delete_template("t")
    assert (await store.restore_template("t")).config == {
        "since": "2020-01-01"
    }
