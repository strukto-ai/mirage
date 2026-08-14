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

from mirage.workspace.session.session import Session
from mirage.workspace.session.shell_dirs import (change_dir, home_dir,
                                                 logical_cwd, set_cwd)


def test_home_dir_unset_is_none():
    session = Session(session_id="s")
    assert home_dir(session) is None


def test_home_dir_from_env():
    session = Session(session_id="s", env={"HOME": "/data"})
    assert home_dir(session) == "/data"


def test_home_dir_empty_env_is_none():
    session = Session(session_id="s", env={"HOME": ""})
    assert home_dir(session) is None


def test_change_dir_sets_cwd_and_oldpwd():
    session = Session(session_id="s", cwd="/data")
    change_dir(session, "/data/sub")
    assert session.cwd == "/data/sub"
    assert session.env["OLDPWD"] == "/data"


def test_change_dir_overwrites_oldpwd():
    session = Session(session_id="s", cwd="/a")
    change_dir(session, "/b")
    change_dir(session, "/c")
    assert session.cwd == "/c"
    assert session.env["OLDPWD"] == "/b"


def test_logical_cwd_falls_back_to_the_physical_cwd():
    assert logical_cwd(Session(session_id="s", cwd="/data")) == "/data"


def test_change_dir_records_a_logical_name_that_differs():
    session = Session(session_id="s", cwd="/data")
    change_dir(session, "/data/deep/real", "/data/lk")
    assert session.cwd == "/data/deep/real"
    assert logical_cwd(session) == "/data/lk"


def test_change_dir_collapses_the_pair_when_the_names_agree():
    # Storing the two names as one collapsed field keeps `logical_cwd`
    # from reporting a stale spelling after a `-P` move.
    session = Session(session_id="s", cwd="/data")
    change_dir(session, "/data/deep/real", "/data/lk")
    change_dir(session, "/data/deep/real", "/data/deep/real")
    assert session.logical_cwd is None
    assert logical_cwd(session) == "/data/deep/real"


def test_oldpwd_records_the_logical_name():
    # It is what `cd -` returns to, so it has to be the spelling.
    session = Session(session_id="s", cwd="/data")
    change_dir(session, "/data/deep/real", "/data/lk")
    change_dir(session, "/tmp")
    assert session.env["OLDPWD"] == "/data/lk"


def test_set_cwd_drops_a_stale_logical_name():
    # A snapshot restore or `workspace.cwd = ...` moves the session with
    # no typed spelling behind it. Leaving the old logical name would
    # make `pwd` describe a directory the session is no longer in.
    session = Session(session_id="s", cwd="/data")
    change_dir(session, "/data/deep/real", "/data/lk")
    set_cwd(session, "/elsewhere")
    assert session.logical_cwd is None
    assert logical_cwd(session) == "/elsewhere"


def test_set_cwd_leaves_oldpwd_alone():
    session = Session(session_id="s", cwd="/data")
    set_cwd(session, "/elsewhere")
    assert "OLDPWD" not in session.env
