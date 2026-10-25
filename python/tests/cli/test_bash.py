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

import os

import pytest

from mirage.cli import bash as bash_module
from mirage.cli.bash import split_args, working_directory


@pytest.mark.parametrize(
    "argv",
    [
        ["-c", "ls -la"],
        ["-c", "-l", "ls -la"],
        ["-lc", "ls -la"],
        ["--login", "-c", "ls -la"],
        ["-o", "pipefail", "-c", "ls -la"],
        ["-c", "--", "ls -la"],
    ],
)
def test_the_line_is_the_first_operand_after_the_options(argv):
    assert split_args(argv) == "ls -la"


def test_a_line_that_starts_with_a_dash_follows_the_end_of_options():
    assert split_args(["-c", "--", "-x"]) == "-x"


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        ([], "only -c is supported"),
        (["script.sh"], "only -c is supported"),
        (["-c"], "-c: option requires an argument"),
        (
            ["-c", "echo $0", "name"],
            "operands after the line are not supported",
        ),
    ],
)
def test_anything_but_one_line_after_c_is_refused(argv, message):
    with pytest.raises(ValueError, match=message):
        split_args(argv)


def test_pwd_names_the_directory_when_it_is_the_same_one(
    tmp_path, monkeypatch
):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    monkeypatch.chdir(link)
    monkeypatch.setenv("PWD", str(link))
    assert working_directory() == str(link)


@pytest.mark.parametrize("pwd", ["elsewhere", "relative/path", "missing"])
def test_the_resolved_path_wins_over_a_pwd_that_is_not_it(
    tmp_path, monkeypatch, pwd
):
    here = tmp_path / "here"
    here.mkdir()
    (tmp_path / "elsewhere").mkdir()
    monkeypatch.chdir(here)
    named = pwd if pwd == "relative/path" else str(tmp_path / pwd)
    monkeypatch.setenv("PWD", named)
    assert working_directory() == os.getcwd()


def run_main(monkeypatch, argv: list[str]) -> list[list[str] | None]:
    calls: list[list[str] | None] = []
    monkeypatch.setattr(bash_module, "cli_main", calls.append)
    monkeypatch.setattr("sys.argv", ["mirage-bash", *argv])
    bash_module.main()
    return calls


def test_a_line_runs_as_mirage_shell_from_the_working_directory(
    tmp_path, monkeypatch
):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PWD", str(tmp_path))
    monkeypatch.setenv("MIRAGE_WORKSPACE", "demo")
    monkeypatch.setenv("MIRAGE_SESSION", "agent")
    assert run_main(monkeypatch, ["-c", "-l", "ls | wc -l"]) == [
        [
            "shell",
            "-w",
            "demo",
            f"--cwd={tmp_path}",
            "-s",
            "agent",
            "--command=ls | wc -l",
        ]
    ]


def test_no_session_runs_as_the_default_one(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PWD", str(tmp_path))
    monkeypatch.setenv("MIRAGE_WORKSPACE", "demo")
    monkeypatch.delenv("MIRAGE_SESSION", raising=False)
    assert run_main(monkeypatch, ["-c", "pwd"]) == [
        ["shell", "-w", "demo", f"--cwd={tmp_path}", "--command=pwd"]
    ]


def test_no_workspace_is_a_usage_error(monkeypatch, capsys):
    monkeypatch.delenv("MIRAGE_WORKSPACE", raising=False)
    with pytest.raises(SystemExit) as exc:
        run_main(monkeypatch, ["-c", "pwd"])
    assert exc.value.code == 2
    assert (
        capsys.readouterr().err == "mirage-bash: MIRAGE_WORKSPACE is not set\n"
    )


def test_a_bad_argument_list_is_a_usage_error(monkeypatch, capsys):
    monkeypatch.setenv("MIRAGE_WORKSPACE", "demo")
    with pytest.raises(SystemExit) as exc:
        run_main(monkeypatch, ["script.sh"])
    assert exc.value.code == 2
    assert capsys.readouterr().err == "mirage-bash: only -c is supported\n"
