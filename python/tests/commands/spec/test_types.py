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

from mirage.commands.spec import SPECS
from mirage.commands.spec.types import (CommandSpec, FlagView, OperandKind,
                                        Option, spec_flag_names)


def test_flag_view_typed_reads():
    fl = FlagView({"i": True, "m": "5", "type": "py", "e": ["a", "b"]})
    assert fl.as_bool("i") is True
    assert fl.as_bool("v") is False
    assert fl.as_int("m") == 5
    assert fl.as_int("A") is None
    assert fl.as_str("type") == "py"
    assert fl.as_str("glob") is None
    assert fl.as_list("e") == ["a", "b"]
    assert fl.as_list("f") == []


def test_flag_view_list_coerces_single_string():
    fl = FlagView({"e": "solo"})
    assert fl.as_list("e") == ["solo"]


def test_flag_view_without_spec_is_lenient():
    fl = FlagView({"anything": True})
    assert fl.as_bool("anything") is True
    assert fl.as_bool("missing") is False


def test_flag_view_with_spec_rejects_unknown_names():
    fl = FlagView({"i": True}, spec=SPECS["grep"])
    assert fl.as_bool("i") is True
    with pytest.raises(KeyError, match="ignorecase"):
        fl.as_bool("ignorecase")
    with pytest.raises(KeyError):
        fl.as_int("max_count")
    with pytest.raises(KeyError):
        fl.as_list("patterns")


def test_spec_flag_names_includes_short_long_and_ambiguous():
    spec = CommandSpec(options=(
        Option(short="l"),
        Option(short="m", long="--max-count", value_kind=OperandKind.TEXT),
        Option(long="--hidden"),
    ))
    names = spec_flag_names(spec)
    assert names == frozenset({"args_l", "m", "max_count", "hidden"})
