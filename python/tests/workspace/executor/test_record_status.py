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

import pathlib
import re

import pytest

from mirage import MountMode, RAMResource, Workspace
from mirage.shell.node_kind import pipeline_transparent
from mirage.shell.parse import parse
from mirage.workspace.executor.statement import record_status
from mirage.workspace.session import Session

_SRC = pathlib.Path(__file__).resolve().parents[3] / "mirage"


def test_every_status_write_goes_through_the_door():
    # `$?` and `${PIPESTATUS[@]}` are recorded together by record_status;
    # a direct write anywhere else would let the two disagree.
    offenders = []
    for path in _SRC.rglob("*.py"):
        if path.name == "statement.py":
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if re.search(r"\.last_exit_code\s*=[^=]", line):
                offenders.append(f"{path.relative_to(_SRC)}:{lineno}")
    assert offenders == []


def test_record_status_claims_a_parked_pipeline():
    s = Session(session_id="s")
    s._pipe_status_pending = (1, 0)
    record_status(s, 0)
    assert (s.last_exit_code, s.pipe_status) == (0, (1, 0))
    assert s._pipe_status_pending is None
    record_status(s, 3)
    assert s.pipe_status == (3, )


def test_transparent_statement_keeps_the_inner_record():
    s = Session(session_id="s")
    record_status(s, 1)
    s._pipe_status_pending = (1, 0)
    record_status(s, 0, transparent=True)
    assert s.pipe_status == (1, 0)
    record_status(s, 0, transparent=True)
    assert s.pipe_status == (1, 0)


@pytest.mark.parametrize(
    "line,transparent",
    [
        ("{ a; }", True),
        ("(a)", False),
        ("(( 1 ))", False),
        ("! a", True),
        ("a | b", False),
        ("a && b", False),
        # A redirected statement is as transparent as what it redirects.
        ("a > f", False),
        ("> f", False),
        ("{ a; } > f", True),
        ("if a; then b; fi > f", True),
        ("if a; then b; fi", True),
        ("for i in 1; do a; done", True),
        ("while a; do b; done", True),
        ("case x in x) a;; esac", True),
        ("f() { a; }", True),
        ("a", False),
        ("x=1", False),
    ])
def test_pipeline_transparent(line, transparent):
    assert pipeline_transparent(parse(line).named_children[0]) is transparent


async def _out(ws: Workspace, line: str) -> str:
    ws.create_session(line)
    io = await ws.execute(line, session_id=line)
    return (await io.stdout_str()).strip()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected",
    [
        ("false | true; echo ${PIPESTATUS[@]}", "1 0"),
        ("false; echo ${PIPESTATUS[@]} $PIPESTATUS ${#PIPESTATUS[@]}",
         "1 1 1"),
        ("true | false | true; echo ${PIPESTATUS[1]} ${PIPESTATUS[*]}",
         "1 0 1 0"),
        ("(false | true); echo ${PIPESTATUS[@]}", "0"),
        ("if false | true; then :; fi; echo ${PIPESTATUS[@]}", "0"),
        ("false | true; x=1; echo ${PIPESTATUS[@]}", "0"),
        ("false | true; echo ${PIPESTATUS[@]}; echo ${PIPESTATUS[@]}",
         "1 0\n0"),
        ("set -o pipefail; false | true; echo $? ${PIPESTATUS[@]}", "1 1 0"),
        # A fresh shell's PIPESTATUS is empty (pinned on bash 5.2 in an
        # isolated run), and a loop that never iterates leaves the record
        # as it stood, empty included.
        ("echo \"[${PIPESTATUS[@]}]\"", "[]"),
        ("for x in; do :; done; echo \"[${PIPESTATUS[@]}]\"", "[]"),
        ("false; for x in; do :; done; echo ${PIPESTATUS[@]}", "1"),
        ("false | true; for x in; do :; done; echo ${PIPESTATUS[@]}", "1 0"),
        ("f() { :; }; echo \"[${PIPESTATUS[@]}]\"", "[]"),
        ("! false | true; echo $? ${PIPESTATUS[@]}", "1 1 0"),
        ("f() { false | true; }; f; echo ${PIPESTATUS[@]}", "0"),
        ("false | true; { true; false; } | echo ${PIPESTATUS[*]}", "1 0"),
        ("false | true; f() { true; false; }; f | echo ${PIPESTATUS[*]}",
         "1 0"),
        ("false | { true; false; }; echo ${PIPESTATUS[*]}", "1 1"),
        ("false | ( true; false ); echo ${PIPESTATUS[*]}", "1 1"),
        ("g() { false | true; return 5; }; g; echo ${PIPESTATUS[@]}", "5"),
        ("exit 3 | true; echo ${PIPESTATUS[@]}", "3 0"),
        ("false | true > /dev/null; echo ${PIPESTATUS[@]}", "1 0"),
        ("{ false | true; }; echo ${PIPESTATUS[@]}", "1 0"),
        ("{ { false | true; }; }; echo ${PIPESTATUS[@]}", "1 0"),
        ("for i in 1; do false | true; done; echo ${PIPESTATUS[@]}", "1 0"),
        ("if true; then false | true; fi; echo ${PIPESTATUS[@]}", "1 0"),
        ("case x in x) false | true;; esac; echo ${PIPESTATUS[@]}", "1 0"),
        ("false | true; :; echo ${PIPESTATUS[@]}", "0"),
        ("false | true; [[ -n x ]]; echo ${PIPESTATUS[@]}", "0"),
        ("false | true; (( 1 )); echo ${PIPESTATUS[@]}", "0"),
        ("false | true; echo ${PIPESTATUS[5]:-unset} ${#PIPESTATUS[@]} "
         "${!PIPESTATUS[@]}", "unset 2 0 1"),
        ("PIPESTATUS=(9 9); echo ${PIPESTATUS[@]}", "0"),
        ("false | true; f() { :; }; echo ${PIPESTATUS[@]}", "1 0"),
        ("true && false | true; echo ${PIPESTATUS[@]}", "1 0"),
        ("false | true && true; echo ${PIPESTATUS[@]}", "0"),
        ("false && false | true; echo ${PIPESTATUS[@]}", "1"),
        # A short-circuited list reports the pipeline it did run.
        ("true | false && true; echo ${PIPESTATUS[@]}", "0 1"),
        ("false | true || true; echo ${PIPESTATUS[@]}", "1 0"),
        ("true | false || false | true; echo ${PIPESTATUS[@]}", "1 0"),
        # `!` reports the negated pipeline's own statuses; a loop left
        # through break or continue reports the builtin's 0.
        ("false | true; ! false; echo $? ${PIPESTATUS[@]}", "0 1"),
        ("false | true; ! true; echo $? ${PIPESTATUS[@]}", "1 0"),
        ("false | true; ! false | true; echo $? ${PIPESTATUS[@]}", "1 1 0"),
        ("false | true; for i in 1; do break; done; echo $? ${PIPESTATUS[@]}",
         "0 0"),
        ("false | true; for i in 1; do continue; done; "
         "echo $? ${PIPESTATUS[@]}", "0 0"),
        ("false | true; while true; do break 1; done; "
         "echo $? ${PIPESTATUS[@]}", "0 0"),
        # A redirected statement is as transparent as what it redirects: a
        # simple command stamps its one-segment status whether or not the
        # redirect opened, a redirected group keeps the stale record.
        ("false | true; echo hi >/f; echo ${PIPESTATUS[@]}", "0"),
        ("false | true; cat </missing; echo ${PIPESTATUS[@]}", "1"),
        ("false | true; (cat) </missing; echo ${PIPESTATUS[@]}", "1"),
        ("false | true; </missing; echo ${PIPESTATUS[@]}", "1"),
        ("false | true; { cat; } </missing; echo ${PIPESTATUS[@]}", "1 0"),
        ("false | true; if true; then :; fi </missing; echo ${PIPESTATUS[@]}",
         "1 0"),
        ("false | true; true | cat </missing; echo ${PIPESTATUS[@]}", "0 1"),
    ])
async def test_pipestatus_matches_bash(line, expected):
    # Every expectation here was pinned against GNU bash 5.2 on
    # debian:stable-slim.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    assert await _out(ws, line) == expected


@pytest.mark.asyncio
async def test_pipestatus_is_not_listed_by_declare():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    io = await ws.execute("declare -p PIPESTATUS")
    assert io.exit_code == 1
