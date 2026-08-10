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

from typing import Any

import pytest

from mirage.runtime.python.bootstrap import bootstrap


@pytest.mark.parametrize("prog", [None, "-c"])
def test_a_payload_passes_through_untouched(prog):
    assert bootstrap("print(1)", prog) == "print(1)"


def test_a_script_sets_argv0_and_compiles_under_its_own_name():
    out = bootstrap("print(1)", "/s.py")
    assert "argv[0] = '/s.py'" in out
    assert "'/s.py', 'exec'" in out


@pytest.mark.parametrize("prog", ["", "-"])
def test_both_stdin_doors_compile_as_stdin(prog):
    out = bootstrap("print(1)", prog)
    assert "'<stdin>', 'exec'" in out
    assert f"argv[0] = {prog!r}" in out


def test_the_preamble_binds_no_name_in_the_programs_namespace():
    ns: dict[str, Any] = {}
    exec(bootstrap("names = sorted(globals())", "/s.py"), ns)
    # Read at the program's first statement, so it is what the program
    # starts with: the preamble imported sys without binding it.
    assert ns["names"] == ["__builtins__"]


def test_a_quote_in_the_program_survives_the_round_trip():
    ns: dict[str, Any] = {}
    exec(bootstrap("v = 'it\\'s \"quoted\"'", "/s.py"), ns)
    assert ns["v"] == "it's \"quoted\""
