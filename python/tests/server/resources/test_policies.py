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
from mirage.resources.types import Policy
from mirage.server.resources.policies import with_policies

SOURCE = "def pre_command(ctx):\n    return None\n"


def _programs(*scripts):
    return {
        "profiles": {
            "reviewer": {
                "policy": {"pre_command": [{"script": s} for s in scripts]}
            }
        }
    }


@pytest.mark.asyncio
async def test_a_script_naming_a_saved_policy_gets_its_source():
    store = memory_resource_store()
    await store.create_policy(Policy(name="guard.py", source=SOURCE))
    written = _programs("guard.py", "unsaved.py", "./local.py")
    assert await with_policies(store, written) == _programs(
        {"source": SOURCE, "language": "python"}, "unsaved.py", "./local.py"
    )


@pytest.mark.asyncio
async def test_the_config_comes_back_when_no_script_is_saved():
    written = _programs("a.py")
    assert await with_policies(memory_resource_store(), written) is written
