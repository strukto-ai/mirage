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

from mirage.runtime.handles import parse_mode
from mirage.runtime.handles.mode import OpenMode
from mirage.runtime.open import apply_open
from mirage.runtime.types import VFSStat

F = "/data/f"
# C fopen's "wx", what a QuickJS or WASI guest opens with: exclusive
# creation that also carries the truncate fact, which exclusivity must
# outrank so a refused open leaves the content alone.
WX = OpenMode(
    readable=False,
    writable=True,
    truncate=True,
    append=False,
    create=True,
    exclusive=True,
    binary=False,
)


class World:
    """A filesystem for the rule to land on, recording every effect.

    An implied directory lists but has no row, the root above a nested
    mount; a dangling link has a row only for a no-follow stat.
    """

    def __init__(self, files=(), dirs=(), implied=(), links=()):
        self.files = set(files)
        self.dirs = set(dirs)
        self.implied = set(implied)
        self.links = set(links)
        self.effects = []

    def stat_or_none(self, path, *, nofollow=False):
        if path in self.files:
            return VFSStat(size=1, is_dir=False, mode=0o100644, mtime_ns=0)
        if path in self.dirs:
            return VFSStat(size=0, is_dir=True, mode=0o40755, mtime_ns=0)
        if path in self.links and nofollow:
            return VFSStat(
                size=8, is_dir=False, mode=0o120777, mtime_ns=0, is_link=True
            )
        return None

    def listing_or_none(self, path):
        if path in self.dirs or path in self.implied:
            return []
        return None

    def create(self, path):
        self.effects.append(("create", path))

    def truncate(self, path):
        self.effects.append(("truncate", path))


@pytest.mark.parametrize(
    "mode, world, effect, kept, refusal",
    [
        ("r", {"files": [F]}, [], True, None),
        ("r", {}, [], False, FileNotFoundError),
        ("r", {"dirs": [F]}, [], False, IsADirectoryError),
        ("r", {"implied": [F]}, [], False, IsADirectoryError),
        ("r", {"links": [F]}, [], False, FileNotFoundError),
        ("w", {"files": [F]}, [("truncate", F)], False, None),
        ("w", {}, [("create", F)], False, None),
        ("w", {"implied": [F]}, [], False, IsADirectoryError),
        ("a", {"files": [F]}, [], True, None),
        ("a", {}, [("create", F)], False, None),
        ("a", {"implied": [F]}, [], False, IsADirectoryError),
        (WX, {"files": [F]}, [], False, FileExistsError),
        (WX, {"links": [F]}, [], False, FileExistsError),
        (WX, {"implied": [F]}, [], False, FileExistsError),
        (WX, {}, [("create", F)], False, None),
    ],
)
def test_an_open_lands_its_modes_effect_before_any_byte_moves(
    mode, world, effect, kept, refusal
):
    surface = World(**world)
    facts = parse_mode(mode) if isinstance(mode, str) else mode
    if refusal is None:
        assert (apply_open(surface, F, facts) is not None) == kept
    else:
        with pytest.raises(refusal):
            apply_open(surface, F, facts)
    assert surface.effects == effect


class _NoTruncate(World):
    def truncate(self, path):
        raise NotImplementedError("truncate")


def test_an_open_on_a_mount_with_no_truncate_empties_through_create():
    # hf buckets and databricks volumes register create but no truncate;
    # an empty create is the same effect, so the open still lands it.
    surface = _NoTruncate(files=[F])
    assert apply_open(surface, F, parse_mode("w")) is None
    assert surface.effects == [("create", F)]
