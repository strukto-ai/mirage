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
import importlib
import inspect
import pkgutil
from collections.abc import Awaitable, Callable

import pytest

import mirage.commands.builtin as builtin
from mirage.commands.builtin.generic_bind.adapter import CommandIO


def _writers() -> dict[str, Callable[..., Awaitable[None]]]:
    found: dict[str, Callable[..., Awaitable[None]]] = {}
    for info in pkgutil.iter_modules(builtin.__path__):
        name = f"{builtin.__name__}.{info.name}.io"
        try:
            module = importlib.import_module(name)
        except ModuleNotFoundError as exc:
            # Only a package with no IO table is skipped; an IO table
            # whose own imports fail must fail the scan, not drop out.
            if exc.name != name:
                raise
            continue
        table = getattr(module, "IO", None)
        if isinstance(table, CommandIO) and table.write is not None:
            found[info.name] = table.write
    return found


WRITERS = _writers()


def test_the_scan_reaches_every_whole_file_writer():
    # A scan that found nothing would pass every assertion below.
    assert {"onedrive", "sharepoint", "s3", "ram", "disk", "dropbox"} <= set(
        WRITERS
    )


@pytest.mark.parametrize("name", sorted(WRITERS))
def test_every_whole_file_write_settles_instead_of_invalidating(name):
    # A writer holds the file's full new bytes, so it settles them with the
    # cache; one that still only invalidates would drop what it wrote, and
    # with apply_io no longer storing written paths nothing else keeps them.
    source = inspect.getsource(WRITERS[name])
    assert "settle_after_write(" in source
    assert "write_generation()" in source
    assert "invalidate_after_write(" not in source
