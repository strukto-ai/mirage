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
from mirage.workspace.session.shell_dirs import change_dir, home_dir


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
