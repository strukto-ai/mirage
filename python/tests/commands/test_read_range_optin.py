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
import pkgutil

import mirage.commands.builtin as builtin
import mirage.resource as resources
from mirage.commands.builtin.generic_bind import CommandIO
from mirage.resource.base import BaseResource
from mirage.utils.params import accepts_kwarg

WINDOW = ("offset", "size")
RESOURCE_RANGE = "range_read"


def _backend(module_name: str) -> str:
    """The backend a builtin io module belongs to.

    Args:
        module_name (str): dotted module name ending in ``.io``.
    """
    return module_name.rsplit(".", 2)[-2]


def _tables() -> tuple[dict[str, CommandIO], list[str]]:
    """Every backend's CommandIO by backend name, plus modules that failed.

    Import failures are returned rather than skipped: a backend whose
    io module will not import contributes no table, so a missing
    ``read_range`` would pass by being absent rather than by being
    correct.
    """
    found: dict[str, CommandIO] = {}
    failed: list[str] = []
    for info in pkgutil.walk_packages(builtin.__path__,
                                      builtin.__name__ + "."):
        if not info.name.endswith(".io"):
            continue
        try:
            module = importlib.import_module(info.name)
        except ImportError as exc:
            failed.append(f"{info.name}: {exc}")
            continue
        table = getattr(module, "IO", None)
        if isinstance(table, CommandIO):
            found[_backend(info.name)] = table
    return found, failed


def _resource_ranges() -> set[str]:
    """Backend names whose resource exposes the ``range_read`` method.

    The resource-level window is a second spelling of the same
    capability, reached as ``resource.range_read(path, start, end)``
    rather than through the op dispatcher. It is derived from the
    ``_ops`` table each resource class declares.
    """
    found: set[str] = set()
    for info in pkgutil.walk_packages(resources.__path__,
                                      resources.__name__ + "."):
        try:
            module = importlib.import_module(info.name)
        except ImportError:
            continue
        for value in vars(module).values():
            if (isinstance(value, type) and issubclass(value, BaseResource)
                    and RESOURCE_RANGE in getattr(value, "_ops", {})):
                found.add(value._ops[RESOURCE_RANGE].__module__.split(".")[2])
    return found


def test_a_reader_that_takes_a_window_is_wired_as_the_native_range():
    """A backend that can range must say so, or nobody ever asks it to.

    ``read_range`` is what tells the ops factory a backend can fetch a
    window; without it the factory reads the whole object and slices,
    which is correct and silent and throws away the entire point. Eight
    backends already took ``offset``/``size`` on their reader and none
    were wired, so the parameters sat dead for as long as they existed.
    Derived from the signature rather than listed so a new backend that
    grows a window is required to wire it too.
    """
    tables, failed = _tables()
    assert not failed, f"backend io modules would not import: {failed}"
    assert tables, "no backend tables found: the derivation broke"
    missing = sorted(name for name, io in tables.items()
                     if io.read_range is None and all(
                         accepts_kwarg(io.read_bytes, p) for p in WINDOW))
    assert not missing, (
        f"reader takes offset/size but read_range is unwired: {missing}")


def test_a_wired_range_reader_actually_takes_a_window():
    """The mirror: what is wired has to accept what it will be handed.

    The factory calls it as ``(accessor, path, index, offset, size)``,
    so a function that does not take the last two fails at the call, and
    only on the first ranged read of that backend.
    """
    tables, failed = _tables()
    assert not failed, f"backend io modules would not import: {failed}"
    wrong = sorted(name for name, io in tables.items()
                   if io.read_range is not None and not all(
                       accepts_kwarg(io.read_range, p) for p in WINDOW))
    assert not wrong, f"read_range does not take offset/size: {wrong}"


def test_a_backend_that_ranges_for_its_resource_ranges_for_the_ops_path_too():
    """The two range surfaces have to agree on what a backend can do.

    A ranged read is reachable two ways: ``resource.range_read(path,
    start, end)`` on the resource object, and the ops dispatcher's
    ``read(path, offset, size)`` through ``CommandIO.read_range``. A
    backend wired for one and not the other is the same class of bug
    that left eight readers taking a window nobody handed them: the
    capability exists, one caller gets it, and the other quietly
    downloads the whole object and slices.
    """
    tables, failed = _tables()
    assert not failed, f"backend io modules would not import: {failed}"
    ranged = _resource_ranges()
    assert ranged, "no resource-level range_read found: the derivation broke"
    gaps = sorted(name for name in ranged
                  if name in tables and tables[name].read_range is None)
    assert not gaps, (f"resource ranges but the ops path does not: {gaps}")
