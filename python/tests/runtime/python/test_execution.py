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

from mirage.runtime.python.execution import main_filename, prepare_source
from mirage.runtime.types import RunArgs
from mirage.types import PathSpec


def _script(raw: str, virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] + "/",
        vfs_path=virtual.strip("/"),
        raw_path=raw,
    )


def _run(
    code: str = "print(1)",
    prog: str | None = None,
    script: PathSpec | None = None,
    cwd: str | None = None,
) -> RunArgs:
    return RunArgs(
        code=code,
        prog=prog,
        script_path=script,
        cwd=None if cwd is None else PathSpec.from_str_path(cwd),
    )


@pytest.mark.parametrize("prog", [None, "-c"])
def test_a_payload_passes_through_untouched(prog):
    assert prepare_source(_run(prog=prog)) == "print(1)"


@pytest.mark.parametrize(
    "raw, cwd, name",
    [
        ("/w/s.py", "/", "/w/s.py"),
        ("s.py", "/w", "/w/s.py"),
        ("./app/s.py", "/w", "/w/./app/s.py"),
        ("../w/s.py", "/w", "/w/../w/s.py"),
        ("w/s.py", "/", "/w/s.py"),
    ],
)
def test_a_script_is_named_as_typed_against_the_cwd(raw, cwd, name):
    # CPython 3.13.5: absolute against the working directory, never
    # normalized, whatever the spelling.
    script = _script(raw, "/w/s.py")
    assert main_filename(_run(prog=raw, script=script, cwd=cwd)) == name


def test_a_script_sets_argv0_file_and_compiles_under_its_own_name():
    script = _script("s.py", "/w/s.py")
    out = prepare_source(_run(prog="s.py", script=script, cwd="/w"))
    assert "argv[0] = 's.py'" in out
    assert "__file__ = '/w/s.py'" in out
    assert "'/w/s.py', 'exec'" in out


@pytest.mark.parametrize("prog", ["", "-"])
def test_both_stdin_entry_points_compile_as_stdin(prog):
    out = prepare_source(_run(prog=prog))
    assert "'<stdin>', 'exec'" in out
    assert "__file__ = '<stdin>'" in out
    assert f"argv[0] = {prog!r}" in out


def test_a_module_names_no_file():
    out = prepare_source(_run(prog="json.tool"))
    assert "'json.tool', 'exec'" in out
    assert "__file__" not in out


def test_the_preamble_binds_only_what_the_file_adapter_binds():
    ns: dict[str, Any] = {}
    script = _script("/s.py", "/s.py")
    exec(
        prepare_source(_run("names = sorted(globals())", "/s.py", script)), ns
    )
    # Read at the program's first statement, so it is what the program
    # starts with: the preamble imported sys without binding it.
    assert ns["names"] == ["__builtins__", "__cached__", "__file__"]
    assert ns["__file__"] == "/s.py"


def test_the_script_directory_heads_sys_path_only_when_asked():
    script = _script("/w/app/s.py", "/w/app/s.py")
    run = _run(prog="/w/app/s.py", script=script)
    assert "sys').path[0]" not in prepare_source(run)
    assert "safe_path" in prepare_source(run, search_path=True)
    assert "sys').path[0]" not in prepare_source(
        _run(prog="-"), search_path=True
    )


def test_a_quote_in_the_program_survives_the_round_trip():
    ns: dict[str, Any] = {}
    script = _script("/s.py", "/s.py")
    exec(prepare_source(_run("v = 'it\\'s \"quoted\"'", "/s.py", script)), ns)
    assert ns["v"] == 'it\'s "quoted"'
