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
from collections.abc import Callable
from typing import Any

import pytest

from mirage.vfs.base import BaseVFS
from mirage.vfs.dev.dev import DevVFS
from mirage.vfs.registry import REGISTRY, resolve_class
from mirage.vfs.s3 import S3VFS

# Every backend that takes the window itself instead of leaving it to the
# read-and-slice fallback. Most push it down to the store (one ranged GET
# rather than the whole object); the ones that render their content or
# already hold it in memory take the window right after building the
# bytes, so a windowed read is answered the same way everywhere. Losing a
# name here is not a test failure anywhere else: the fallback keeps the
# backend correct while it silently starts reading whole objects again.
NATIVE_RANGE = {
    "box",
    "databricks_volume",
    "dify",
    "discord",
    "disk",
    "dropbox",
    "gdrive",
    "gridfs",
    "hf_buckets",
    "hf_datasets",
    "hf_models",
    "hf_spaces",
    "nextcloud",
    "onedrive",
    "ram",
    "redis",
    "s3",
    "sharepoint",
    "slack",
    "ssh",
}

WINDOW = ("offset", "size")


def _classes() -> dict[str, type[BaseVFS]]:
    return {name: resolve_class(e.vfs_path) for name, e in REGISTRY.items()}


def _takes_window(fn: Callable[..., Any]) -> bool:
    """Whether ``fn`` declares both window parameters as its own.

    A reader's ``**kwargs`` never answers for one: backends use that as an
    opaque bag of command-line flags and forward it wholesale.
    """
    parameters = inspect.signature(fn).parameters
    for name in WINDOW:
        parameter = parameters.get(name)
        if (
            parameter is None
            or parameter.kind is inspect.Parameter.VAR_KEYWORD
        ):
            return False
    return True


def _readers(cls: type[BaseVFS]) -> list[Callable[..., Any]]:
    """The backend functions a VFS's ``read`` hands its work to."""
    method = next(
        klass.__dict__["read"]
        for klass in cls.__mro__
        if "read" in klass.__dict__
    )
    return [
        target
        for name in method.__code__.co_names
        if callable(target := method.__globals__.get(name))
        and not isinstance(target, type)
        and target.__name__ != "slice_window"
    ]


def test_native_range_roster_is_exactly_the_declared_set():
    aliases = {
        name for name, cls in _classes().items() if issubclass(cls, S3VFS)
    }
    ranged = {name for name, cls in _classes().items() if cls.reads_ranges}
    assert ranged == NATIVE_RANGE | aliases
    assert DevVFS.reads_ranges


@pytest.mark.parametrize("name", sorted(REGISTRY))
def test_a_reader_that_takes_a_window_reads_ranges(name):
    """A backend that can range must say so, or nobody ever asks it to.

    ``reads_ranges`` is what tells the door a VFS can fetch a window;
    without it the door reads the whole object and slices, which is
    correct and silent and throws away the entire point. Derived from the
    signature rather than listed, so a new backend that grows a window is
    required to declare it too.
    """
    cls = _classes()[name]
    if cls.reads_ranges:
        assert any(_takes_window(fn) for fn in _readers(cls))
    else:
        assert not any(_takes_window(fn) for fn in _readers(cls))
