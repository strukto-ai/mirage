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

import ast
import inspect
import textwrap

from mirage.mount.writebuf import WriteBuffer
from mirage.nfs.ids import IdTable

STATE_CLASSES = (IdTable, WriteBuffer)


def _methods_with_await(cls: type) -> list[str]:
    tree = ast.parse(textwrap.dedent(inspect.getsource(cls)))
    offenders = []
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef):
            offenders.append(node.name)
            continue
        if isinstance(node, ast.FunctionDef):
            if any(
                    isinstance(inner, (ast.Await, ast.AsyncFor, ast.AsyncWith))
                    for inner in ast.walk(node)):
                offenders.append(node.name)
    return offenders


def test_adapter_state_is_await_free():
    """The adapter's state holders must stay synchronous.

    They carry no lock because the event loop cannot interleave a
    synchronous function: each runs to completion before another
    callback proceeds. One ``await`` inside any of these methods breaks
    that invariant silently, and a lock would not restore it -- the
    fix would be to make the caller hold the state consistent instead.
    """
    for cls in STATE_CLASSES:
        assert not _methods_with_await(cls), (
            f"{cls.__name__} gained an await; see the class docstring")


def test_adapter_state_holds_no_lock():
    """No threading primitives: mirage spawns no threads for NFS."""
    for cls in STATE_CLASSES:
        source = inspect.getsource(cls)
        assert "Lock()" not in source and "threading" not in source
