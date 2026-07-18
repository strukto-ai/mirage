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

from mirage.server.daemon_config import (ALLOWED_KEYS, DaemonConfigError,
                                         read_daemon_table,
                                         validate_daemon_table)


def test_read_daemon_table_missing_file(tmp_path):
    assert read_daemon_table(tmp_path) == {}


def test_read_daemon_table_no_daemon_section(tmp_path):
    (tmp_path / "config.toml").write_text("[other]\nx = 1\n")
    assert read_daemon_table(tmp_path) == {}


def test_read_daemon_table_reads_keys(tmp_path):
    (tmp_path / "config.toml"
     ).write_text('[daemon]\nurl = "http://h:1"\nsocket = "/tmp/s.sock"\n')
    table = read_daemon_table(tmp_path)
    assert table["url"] == "http://h:1"
    assert table["socket"] == "/tmp/s.sock"


def test_read_daemon_table_malformed_toml(tmp_path):
    (tmp_path / "config.toml").write_text("[daemon\nnot toml")
    with pytest.raises(DaemonConfigError, match="config.toml"):
        read_daemon_table(tmp_path)


def test_allowed_keys_contents():
    assert "port" in ALLOWED_KEYS
    assert "MIRAGE_HOME" not in ALLOWED_KEYS


def test_validate_accepts_known_keys():
    validate_daemon_table({"url": "http://h:1", "idle_grace_seconds": 45})


def test_validate_rejects_unknown_keys():
    with pytest.raises(DaemonConfigError, match="typo_key"):
        validate_daemon_table({"typo_key": "x", "url": "http://h:1"})


def test_validate_rejects_wrong_type():
    with pytest.raises(DaemonConfigError, match="url"):
        validate_daemon_table({"url": 123})


def test_validate_accepts_numeric_grace_and_rejects_string():
    validate_daemon_table({"idle_grace_seconds": 12.5})
    with pytest.raises(DaemonConfigError, match="idle_grace_seconds"):
        validate_daemon_table({"idle_grace_seconds": "soon"})
