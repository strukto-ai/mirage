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


from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from mirage.resources.memory import memory_resource_store
from mirage.server import build_app

GUARD = "def pre_command(call):\n    return None\n"


@pytest.fixture
def app() -> FastAPI:
    return build_app(
        idle_grace_seconds=10.0, resource_store=memory_resource_store()
    )


@pytest_asyncio.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


@pytest.mark.asyncio
async def test_a_policy_is_created_listed_updated_and_deleted(client):
    r = await client.post(
        "/v1/policies", json={"name": "guard.py", "source": GUARD}
    )
    assert r.status_code == 201, r.text
    assert r.json() == {"name": "guard.py", "source": GUARD}
    r = await client.post(
        "/v1/policies", json={"name": "guard.py", "source": GUARD}
    )
    assert r.status_code == 409
    assert (await client.get("/v1/policies")).json() == {
        "items": [{"name": "guard.py"}]
    }
    r = await client.put("/v1/policies/guard.py", json={"source": "x = 1\n"})
    assert r.json() == {"name": "guard.py", "source": "x = 1\n"}
    r = await client.get("/v1/policies/guard.py")
    assert r.json() == {"name": "guard.py", "source": "x = 1\n"}
    assert (await client.delete("/v1/policies/guard.py")).status_code == 204
    assert (await client.get("/v1/policies/guard.py")).status_code == 404
    assert (await client.delete("/v1/policies/guard.py")).status_code == 404


@pytest.mark.asyncio
async def test_a_missing_policy_is_not_updated(client):
    r = await client.put("/v1/policies/guard.py", json={"source": GUARD})
    assert r.status_code == 404
    assert (await client.get("/v1/policies")).json() == {"items": []}


@pytest.mark.asyncio
async def test_a_policy_name_and_source_are_checked(client):
    r = await client.post("/v1/policies", json={"name": "guard", "source": ""})
    assert r.status_code == 400
    assert "end in .py" in r.json()["error"]["message"]
    big = "#" * (64 * 1024 + 1)
    r = await client.post(
        "/v1/policies", json={"name": "big.py", "source": big}
    )
    assert r.status_code == 400
    r = await client.post(
        "/v1/policies", json={"name": "a.py", "source": "", "x": 1}
    )
    assert r.status_code == 400
