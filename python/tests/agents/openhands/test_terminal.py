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

pytest.importorskip("openhands")

from openhands.sdk.tool import list_registered_tools  # noqa: E402

from mirage.agents.openhands import MirageWorkspace  # noqa: E402
from mirage.agents.openhands import register_mirage_terminal  # noqa: E402
from mirage.resource.ram import RAMResource  # noqa: E402
from mirage.types import MountMode  # noqa: E402
from mirage.workspace import Workspace  # noqa: E402


def test_register_mirage_terminal_uses_tool_definition():
    backing = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    with MirageWorkspace(workspace=backing) as workspace:
        name = register_mirage_terminal(workspace, "mirage_terminal_test")
        assert name in list_registered_tools()
