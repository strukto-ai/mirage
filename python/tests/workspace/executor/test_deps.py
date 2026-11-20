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
from dataclasses import replace
from unittest.mock import AsyncMock

import pytest

from mirage.execution.job import JobTable
from mirage.io import IOResult
from mirage.policy import HandOff
from mirage.workspace.executor.deps import (
    ExecuteNodeDeps,
    with_hand_off,
    with_opts,
)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.registry import MountRegistry


def _mock_dispatch():
    d = AsyncMock()
    d.return_value = (b"", IOResult())
    return d


def _run(coro):
    return asyncio.run(coro)


def _deps(**fields):
    registry = MountRegistry()
    return ExecuteNodeDeps(
        _mock_dispatch(),
        registry,
        Namespace(registry),
        JobTable(),
        AsyncMock(return_value=IOResult()),
        **fields,
    )


def test_with_opts_cancel_none_clears_the_event():
    deps = _deps(cancel=asyncio.Event())
    assert with_opts(deps, {"cancel": None}).cancel is None


def test_with_opts_unknown_key_raises():
    with pytest.raises(TypeError, match="jobs"):
        with_opts(_deps(), {"jobs": JobTable()})


def test_execute_fn_follows_the_hand_off():
    deps = _deps(handed=HandOff())
    handed = HandOff()
    for derived in (replace(deps, handed=handed), with_hand_off(deps, handed)):
        deps.entry.reset_mock()
        _run(derived.execute_fn("true", session_id="test"))
        assert deps.entry.call_args.kwargs["handed"] is handed
