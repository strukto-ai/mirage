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

import asyncio
import importlib
import os
import resource
import uuid
from collections.abc import Iterator
from unittest.mock import AsyncMock

import aiohttp
import pytest

from mirage.core.api.client import SessionPool
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.kit_fake import serve

_soft, _hard = resource.getrlimit(resource.RLIMIT_NOFILE)
if _soft < 8192:
    resource.setrlimit(resource.RLIMIT_NOFILE, (min(8192, _hard), _hard))


def pytest_configure(config: pytest.Config) -> None:
    """Turn off the tidying the real git starts behind a test.

    A commit starts ``git maintenance run --auto``, and on a recent git
    (seen on 2.56) its ``.git/objects/maintenance.lock`` is still there
    when the commit returns and goes a moment later, while the test is
    reading that repository. Set before any test module is imported, since
    several build the environment they give git as they load.

    Args:
        config (pytest.Config): the run's configuration.
    """
    os.environ.update(
        {
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "maintenance.auto",
            "GIT_CONFIG_VALUE_0": "false",
        }
    )


async def _close_pools(pools: list[SessionPool]) -> None:
    for pool in pools:
        await pool.close()


@pytest.fixture(autouse=True)
def _drain_session_pools(monkeypatch):
    """Close every SessionPool a test materialized.

    A pooled session lives until its owner's ``close``, which unit tests
    rarely call, so an undrained pool would surface as an aiohttp
    "Unclosed client session" warning at GC. Draining here hides no bug:
    the owner close chains have their own dedicated tests. The teardown
    runs after pytest-asyncio has torn the test's loop down, so
    ``asyncio.run`` opens a fresh one; that is safe because fixture
    teardown never executes under a running loop, and a transport-mocked
    session holds no live connections bound to the old loop.
    """
    made: list[SessionPool] = []
    orig = SessionPool.get

    def tracked(self: SessionPool) -> aiohttp.ClientSession:
        if self not in made:
            made.append(self)
        return orig(self)

    monkeypatch.setattr(SessionPool, "get", tracked)
    yield
    if made:
        asyncio.run(_close_pools(made))


@pytest.fixture(scope="session")
def box_origin() -> Iterator[str]:
    """The integ Box fake's origin, one fake for every test that asks."""
    with serve("box") as origin:
        yield origin


@pytest.fixture(scope="session")
def dropbox_origin() -> Iterator[str]:
    """The integ Dropbox fake's origin, one fake for every test that asks."""
    with serve("dropbox") as origin:
        yield origin


@pytest.fixture(scope="session")
def airtable_origin() -> Iterator[str]:
    """The integ Airtable fake's origin, one fake for every test that
    asks."""
    with serve("airtable") as origin:
        yield origin


@pytest.fixture(scope="session")
def databricks_origin() -> Iterator[str]:
    """The integ Databricks fake's origin, one fake for every test that
    asks."""
    with serve("databricks") as origin:
        yield origin


@pytest.fixture(scope="session")
def graph_origin() -> Iterator[str]:
    """The integ Microsoft Graph (OneDrive) fake's origin, one fake for
    every test that asks."""
    with serve("onedrive") as origin:
        yield origin


@pytest.fixture(scope="session")
def github_origin() -> Iterator[str]:
    """The integ GitHub fake's origin, one fake for every test that asks."""
    with serve("github") as origin:
        yield origin


@pytest.fixture(scope="session")
def gws_origin() -> Iterator[str]:
    """The integ Google Workspace fake's origin, one fake for every test
    that asks."""
    with serve("gws") as origin:
        yield origin


@pytest.fixture
def redis_prefix() -> str:
    """A Redis key prefix that belongs to this one test.

    Every Redis-backed test talks to one server, and pytest-xdist's
    worksteal hands out single tests, so tests of one module run at once
    on different workers. A prefix shared by two modules, or by the tests
    of one, lets one test's ``clear()`` wipe what another just wrote,
    which then reads as a partial listing. A fresh uuid per test rules
    that out whichever module, worker or run the other test is in; a test
    that needs several stores hangs suffixes off it.
    """
    return f"test:{uuid.uuid4().hex}:"


@pytest.fixture
def memory_backend():
    return RAMVFS()


@pytest.fixture
def write_ws():
    ws = Workspace(
        {"/tmp/": RAMVFS()},
        mode=MountMode.WRITE,
    )
    ws.get_session(ws.default_session_id).cwd = "/"
    return ws


@pytest.fixture
def exact_cloud_paths(monkeypatch):
    """Isolate protocol unit tests from the separately tested spelling resolver."""
    drive = importlib.import_module("mirage.core.msgraph.drive")
    modules = [
        importlib.import_module("mirage.core.dropbox." + name)
        for name in (
            "copy",
            "mkdir",
            "read",
            "readdir",
            "rename",
            "rm",
            "rmdir",
            "search",
            "unlink",
            "write",
        )
    ]

    monkeypatch.setattr(drive, "check_item", AsyncMock(return_value=None))
    for provider in ("onedrive", "sharepoint"):
        for name in ("mkdir", "unlink", "rm"):
            module = importlib.import_module(
                "mirage.core." + provider + "." + name
            )
            monkeypatch.setattr(
                module, "check_item", AsyncMock(return_value=None)
            )
    for module in modules:
        monkeypatch.setattr(module, "check_path", AsyncMock(return_value=None))
