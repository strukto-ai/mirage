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

from mirage.commands.builtin.rg_filetypes import (DEFAULT_TYPES,
                                                  INVALID_DEFINITION,
                                                  FileTypes, add_definition,
                                                  type_listing)
from mirage.commands.builtin.rg_glob import Verdict
from mirage.commands.errors import UsageError


def test_a_selected_type_keeps_its_files_and_drops_the_rest():
    types = FileTypes([], [("py", False)])
    assert types.verdict("a.py", False) is Verdict.WHITELIST
    assert types.verdict("a.pyi", False) is Verdict.WHITELIST
    assert types.verdict("a.txt", False) is Verdict.IGNORE


def test_a_negated_type_drops_only_its_files():
    types = FileTypes([], [("txt", True)])
    assert types.verdict("a.txt", False) is Verdict.IGNORE
    assert types.verdict("a.py", False) is Verdict.NONE


def test_the_last_matching_selection_decides():
    # `-t py -T py` drops every .py file.
    assert FileTypes([], [("py", False),
                          ("py", True)]).verdict("a.py",
                                                 False) is Verdict.IGNORE


def test_a_type_never_speaks_for_a_directory():
    assert FileTypes([], [("py", False)]).verdict("py", True) is Verdict.NONE


def test_an_unknown_type_is_refused():
    with pytest.raises(UsageError) as info:
        FileTypes([], [("nosuch", False)])
    assert str(info.value) == "rg: unrecognized file type: nosuch"


def test_all_selects_every_type():
    types = FileTypes([], [("all", False)])
    assert types.verdict("a.rs", False) is Verdict.WHITELIST
    assert types.verdict("noext", False) is Verdict.IGNORE


def test_type_add_extends_and_include_copies():
    types = FileTypes([("add", "foo:*.md")], [("foo", False)])
    assert types.verdict("c.md", False) is Verdict.WHITELIST
    included = FileTypes([("add", "foo:include:py,md")], [("foo", False)])
    assert included.verdict("b.py", False) is Verdict.WHITELIST
    assert included.verdict("c.md", False) is Verdict.WHITELIST


def test_type_clear_empties_a_type_before_it_is_selected():
    with pytest.raises(UsageError):
        FileTypes([("clear", "py")], [("py", False)])


@pytest.mark.parametrize("definition", [
    "nocolon", "foo:", ":*.x", "all:*.x", "a-b:*.x", "foo:bad:py",
    "foo:include:nosuch"
])
def test_a_malformed_definition_is_refused_in_ripgreps_words(definition):
    with pytest.raises(UsageError) as info:
        add_definition({
            name: list(g)
            for name, g in DEFAULT_TYPES.items()
        }, definition)
    assert str(info.value) == INVALID_DEFINITION


def test_type_listing_sorts_names_and_globs():
    # ripgrep 14.1.1: `--type-add 'zz:*.zz' --type-add 'zz:*.yy'` lists
    # `zz: *.yy, *.zz`, and an added glob joins a built-in type.
    types = FileTypes([("add", "zz:*.zz"), ("add", "zz:*.yy"),
                       ("add", "py:*.zz")], [])
    listing = type_listing(types.definitions)
    assert "zz: *.yy, *.zz" in listing
    assert "py: *.py, *.pyi, *.zz" in listing
    assert listing == sorted(listing)
    assert listing[0] == "ada: *.adb, *.ads"
