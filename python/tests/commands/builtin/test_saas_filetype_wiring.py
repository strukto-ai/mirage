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

from mirage.commands.builtin import discord, email, gmail, slack

_EXPECTED_CMDS = {
    "cat", "head", "tail", "wc", "stat", "cut", "file", "grep", "rg"
}
_EXPECTED_EXTS = {
    ".parquet", ".orc", ".feather", ".arrow", ".ipc", ".hdf5", ".h5"
}


@pytest.mark.parametrize("module", [slack, gmail, discord, email])
def test_saas_backend_registers_filetype_commands(module):
    pytest.importorskip("pyarrow")
    found: dict[str, set[str]] = {}
    for cmd in module.COMMANDS:
        for rc in getattr(cmd, "_registered_commands", []):
            if rc.filetype:
                found.setdefault(rc.name, set()).add(rc.filetype)
    assert _EXPECTED_CMDS <= set(found)
    for name in _EXPECTED_CMDS:
        assert _EXPECTED_EXTS <= found[name]
