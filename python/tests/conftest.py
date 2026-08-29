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

import inspect
import resource
from types import SimpleNamespace

import aioresponses.core
import pytest
from aiohttp import ClientResponse

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace

_soft, _hard = resource.getrlimit(resource.RLIMIT_NOFILE)
if _soft < 8192:
    resource.setrlimit(resource.RLIMIT_NOFILE, (min(8192, _hard), _hard))

# aioresponses builds a raw aiohttp.ClientResponse itself (core.py's
# _build_response), and an aiohttp release that made `stream_writer` a
# required __init__ argument broke that construction repo-wide, not just
# under tests/core/. Patched here, once, at collection time, so every
# test tree gets it regardless of which subset of tests/ a run collects.
_NEEDS_STREAM_WRITER = "stream_writer" in inspect.signature(
    ClientResponse.__init__).parameters


class _PatchedClientResponse(ClientResponse):

    def __init__(self, *args: object, **kwargs: object) -> None:
        kwargs.setdefault("stream_writer", SimpleNamespace(output_size=0))
        super().__init__(*args, **kwargs)


if _NEEDS_STREAM_WRITER:
    aioresponses.core.ClientResponse = _PatchedClientResponse


@pytest.fixture
def memory_backend():
    return RAMResource()


@pytest.fixture
def write_ws():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    ws.get_session(ws.default_session_id).cwd = "/"
    return ws
