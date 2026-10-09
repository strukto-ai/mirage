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

from mirage.commands.cli.types import CLIInvocation, CLIView
from mirage.core.hf_hub.config import HfConfig
from mirage.io.stream import yield_bytes
from mirage.types import PathSpec

CONFIG = HfConfig(token="hf_test")
ANON = HfConfig()


def inv(
    texts=(),
    flags=None,
    config=CONFIG,
    view=None,
    stdin=None,
    paths=(),
):
    """One `hf` invocation, as the executor would build it."""
    return CLIInvocation(
        config,
        argv=tuple(texts),
        paths=tuple(PathSpec.from_str_path(p) for p in paths),
        texts=tuple(texts),
        flags=flags or {},
        stdin=None if stdin is None else yield_bytes(stdin),
        view=view,
    )


class FakeView(CLIView):
    """Workspace entry points recording every dispatched op."""


@pytest.fixture
def view():
    calls: list[tuple] = []
    tree = {
        "/work/a.txt": b"alpha",
        "/work/sub/b.txt": b"beta",
    }
    dirs = {"/work", "/work/sub"}

    async def dispatch(op, spec, **kwargs):
        calls.append((op, spec.virtual, kwargs))
        path = spec.virtual
        if op == "read":
            if path not in tree:
                raise FileNotFoundError(path)
            return tree[path], None
        if op == "stat":
            from mirage.types import FileStat, FileType

            if path in dirs:
                return FileStat(name=path, type=FileType.DIRECTORY), None
            if path in tree:
                return FileStat(
                    name=path, type=FileType.FILE, size=len(tree[path])
                ), None
            raise FileNotFoundError(path)
        if op == "readdir":
            children = sorted(
                {
                    p
                    for p in list(tree) + sorted(dirs)
                    if p.rsplit("/", 1)[0] == path.rstrip("/") and p != path
                }
            )
            return children, None
        if op == "mkdir":
            if path in dirs:
                raise FileExistsError(path)
            dirs.add(path)
            return None, None
        if op == "write":
            tree[path] = kwargs.get("data", b"")
            return None, None
        raise AssertionError(f"unexpected op {op}")

    record = CLIView(dispatch=dispatch)
    return record, calls, tree, dirs
