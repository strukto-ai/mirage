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
from pydantic import BaseModel, ConfigDict

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.secrets import registry
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
from mirage.workspace.snapshot.keys import StateKey
from mirage.workspace.snapshot.state import to_state_dict


class FakeConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


@pytest.fixture(autouse=True)
def fresh_custom(monkeypatch):
    monkeypatch.setattr(registry, "_CUSTOM", {})


async def _fetch(config: FakeConfig, ref: str) -> ResolvedSecret:
    return ResolvedSecret(fields={"TOKEN": "t0"})


@pytest.mark.asyncio
async def test_state_env_template_holds_the_pointer_never_a_value():
    register_secrets("fake", FakeConfig, _fetch)
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.WRITE,
                   env={
                       "TOKEN": {
                           "from": "fake",
                           "ref": "r"
                       },
                       "MODE": "m"
                   })
    try:
        # Fetched into the session, so the template writer has to keep
        # writing the declaration rather than the live var.
        assert (await ws.execute("echo $TOKEN")).exit_code == 0
        state = await to_state_dict(ws)
        env = state[StateKey.ENV]
        assert env["env"] == {"MODE": "m"}
        assert env["managed"]["TOKEN"] == {
            "from": "fake",
            "ref": "r",
            "key": "TOKEN"
        }
    finally:
        await ws.close()
