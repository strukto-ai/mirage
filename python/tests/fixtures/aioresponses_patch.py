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
from types import SimpleNamespace
from typing import Any

import aioresponses.core
from aiohttp import ClientResponse


class _PatchedClientResponse(ClientResponse):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        kwargs.setdefault("stream_writer", SimpleNamespace(output_size=0))
        super().__init__(*args, **kwargs)


def patch_aioresponses() -> None:
    """Give aioresponses' canned answers the ``stream_writer`` aiohttp 3.14
    requires, so a directory whose tests mock with it can run.

    The root conftest stays free of aioresponses: the hermes job loads it
    in an environment without the dev extras.
    """
    params = inspect.signature(ClientResponse.__init__).parameters
    if "stream_writer" in params:
        setattr(aioresponses.core, "ClientResponse", _PatchedClientResponse)
