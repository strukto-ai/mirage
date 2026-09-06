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

from mirage.shell.variable import VarAttr, with_attr
from mirage.types import HiddenVars
from mirage.workspace.session import Session
from mirage.workspace.session.elements import assign_element, element_is_set
from mirage.workspace.session.state import seed_var


def _session() -> Session:
    session = Session(session_id="s", cwd="/")
    seed_var(session, "m", {"a": "1", "k5": "9", "0": "z"})
    seed_var(session, "arr", ["10", "20", "30"])
    seed_var(session, "s5", "5")
    seed_var(session, "i", "1")
    return session


def test_element_is_set():
    session = _session()

    async def run():
        assert await element_is_set(session, "m[a]")
        assert not await element_is_set(session, "m[zz]")
        # The subscript is the key verbatim, never arithmetic.
        assert not await element_is_set(session, "m[1+1]")
        assert await element_is_set(session, "m[@]")
        assert await element_is_set(session, "arr[2]")
        assert not await element_is_set(session, "arr[9]")
        assert await element_is_set(session, "arr[@]")
        # An indexed subscript is arithmetic, and what it assigns lands.
        assert await element_is_set(session, "arr[j=2]")
        assert session.vars["j"].value == "2"
        # A bare name over an array checks element 0 (the literal key
        # "0" for an associative one).
        assert await element_is_set(session, "m")
        assert await element_is_set(session, "arr")
        assert await element_is_set(session, "s5")
        assert not await element_is_set(session, "missing")
        assert not await element_is_set(session, "not a ref")

    asyncio.run(run())


def test_assign_element_assoc_and_append():
    session = _session()

    async def run():
        assert await assign_element(session, None, "m", "b", "2") == "ok"
        assert await assign_element(session, None, "m", "b", "x",
                                    append=True) == "ok"
        # A bare target over an associative array is the key "0".
        assert await assign_element(session, None, "m", None, "top") == "ok"
        assert await assign_element(session, None, "m", "", "v") == "subscript"

    asyncio.run(run())
    assert session.assocs["m"]["b"] == "2x"
    assert session.assocs["m"]["0"] == "top"


def test_assign_element_indexed_scalar_and_statuses():
    session = _session()
    session.vars["ro"] = with_attr(session.vars.pop("s5"), VarAttr.READONLY)
    session.hidden_vars = HiddenVars(names=("h", ), patterns=())

    async def run():
        assert await assign_element(session, None, "arr", "1", "X") == "ok"
        assert await assign_element(session, None, "arr", "-1", "Y") == "ok"
        assert await assign_element(session, None, "arr", "-9",
                                    "n") == "subscript"
        # An existing scalar migrates to element 0 under a subscript.
        seed_var(session, "sc", "base")
        assert await assign_element(session, None, "sc", "1", "one") == "ok"
        assert await assign_element(session, None, "ro", "0",
                                    "x") == "readonly"
        assert await assign_element(session, None, "h", "0", "x") == "denied"

    asyncio.run(run())
    assert session.arrays["arr"] == ["10", "X", "Y"]
    assert session.arrays["sc"] == ["base", "one"]
