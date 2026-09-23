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

from mirage.workspace.session.session import SessionState, vars_from_env
from mirage.workspace.workspace.utils import command_name, fork_for_call


@pytest.mark.parametrize("line,expected", [
    ("ls -la /tmp", "ls"),
    ("  ls  ", "ls"),
    ("", ""),
    ("   ", ""),
    ("\tcat\tfile", "cat"),
])
def test_command_name_reads_the_leading_word(line, expected):
    assert command_name(line) == expected


def _session() -> SessionState:
    return SessionState(session_id="s1",
                        cwd="/home",
                        vars=vars_from_env({
                            "A": "1",
                            "B": "2"
                        }))


def test_no_overrides_reuses_the_persistent_session():
    session = _session()
    assert fork_for_call(session, None, None) is session


def test_cwd_override_forks_without_touching_the_original():
    session = _session()
    forked = fork_for_call(session, "/other", None)
    assert forked is not session
    assert forked.cwd == "/other"
    assert session.cwd == "/home"


def test_env_override_layers_on_top_of_the_session_env():
    session = _session()
    forked = fork_for_call(session, None, {"B": "9", "C": "3"})
    assert forked.env == {"A": "1", "B": "9", "C": "3", "PWD": "/home"}
    assert session.env == {"A": "1", "B": "2", "PWD": "/home"}
