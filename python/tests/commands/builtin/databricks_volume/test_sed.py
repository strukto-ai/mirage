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

from mirage.commands.builtin.databricks_volume import COMMANDS


def _sed_command():
    for cmd in COMMANDS:
        for rc in cmd._registered_commands:
            if rc.name == "sed":
                return cmd
    raise LookupError("sed not registered for databricks_volume")


sed_command = _sed_command()


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_sed(
        databricks_text_workspace):
    io = await databricks_text_workspace.execute(
        "sed s/alpha/ALPHA/g /dbx/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta\nALPHA\nALPHA\n"


@pytest.mark.asyncio
async def test_workspace_execute_databricks_volume_sed_resolves_glob(
        databricks_text_workspace):
    io = await databricks_text_workspace.execute(
        "sed s/delta/DELTA/ /dbx/*.txt")

    assert io.exit_code == 0
    assert b"DELTA\n" in io.stdout


@pytest.mark.asyncio
async def test_databricks_volume_sed_in_place_writes_back(
        databricks_text_workspace):
    # The volume has a write op, so -i edits in place through the shared
    # builder (the old bespoke wrapper refused it unconditionally, #382).
    io = await databricks_text_workspace.execute(
        "sed -i s/alpha/ALPHA/g /dbx/words.txt")

    assert io.exit_code == 0
    assert io.writes.get("/dbx/words.txt") == b"beta\nALPHA\nALPHA\n"
