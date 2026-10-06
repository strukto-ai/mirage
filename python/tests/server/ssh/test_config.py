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

from pathlib import Path

import pytest

from mirage.server.daemon_config import ALLOWED_KEYS, NUMERIC_KEYS
from mirage.server.ssh.config import (
    SSHConfig,
    default_ssh_dir,
    resolve_ssh_config,
)
from mirage.server.ssh.constants import DEFAULT_SSH_HOST, SSH_ENV_KEYS
from mirage.server.ssh.errors import SSHConfigError


def test_no_port_means_the_door_stays_shut(tmp_path):
    shut = resolve_ssh_config(env={}, table={}, home=tmp_path)
    assert shut.port is None
    assert shut.host_key_file == tmp_path / "ssh" / "host_ed25519_key"
    assert (
        resolve_ssh_config(
            env={"MIRAGE_SSH_HOST": "0.0.0.0"},
            table={"ssh_host": "0.0.0.0"},
            home=tmp_path,
        ).port
        is None
    )


def test_port_alone_fills_every_default(tmp_path):
    cfg = resolve_ssh_config(
        env={"MIRAGE_SSH_PORT": "2222"}, table={}, home=tmp_path
    )
    assert cfg == SSHConfig(
        port=2222,
        host=DEFAULT_SSH_HOST,
        host_key_file=tmp_path / "ssh" / "host_ed25519_key",
        authorized_keys_file=tmp_path / "ssh" / "authorized_keys",
    )


def test_table_supplies_what_env_does_not(tmp_path):
    cfg = resolve_ssh_config(
        env={},
        table={
            "ssh_port": 2200,
            "ssh_host": "0.0.0.0",
            "ssh_authorized_keys": "/etc/keys",
        },
        home=tmp_path,
    )
    assert cfg is not None
    assert (cfg.port, cfg.host) == (2200, "0.0.0.0")
    assert cfg.authorized_keys_file == Path("/etc/keys")


def test_env_wins_over_table(tmp_path):
    cfg = resolve_ssh_config(
        env={"MIRAGE_SSH_PORT": "2300", "MIRAGE_SSH_HOST": "10.0.0.1"},
        table={"ssh_port": 2200, "ssh_host": "0.0.0.0"},
        home=tmp_path,
    )
    assert cfg is not None
    assert (cfg.port, cfg.host) == (2300, "10.0.0.1")


def test_key_paths_expand_the_home_directory(tmp_path):
    cfg = resolve_ssh_config(
        env={"MIRAGE_SSH_PORT": "2222", "MIRAGE_SSH_HOST_KEY_FILE": "~/k"},
        table={},
        home=tmp_path,
    )
    assert cfg is not None
    assert cfg.host_key_file == Path("~/k").expanduser()


@pytest.mark.parametrize("raw", ["ssh", "22.5", "0", "65536", "-1"])
def test_unusable_port_is_refused_by_name(tmp_path, raw):
    with pytest.raises(SSHConfigError, match="ssh_port"):
        resolve_ssh_config(
            env={"MIRAGE_SSH_PORT": raw}, table={}, home=tmp_path
        )


def test_explicit_env_reads_no_config_file(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    for name in SSH_ENV_KEYS.values():
        monkeypatch.delenv(name, raising=False)
    (tmp_path / "config.toml").write_text("[daemon]\nssh_port = 2222\n")
    assert resolve_ssh_config(env={}).port is None
    assert resolve_ssh_config().port == 2222


def test_every_setting_is_a_daemon_config_key():
    assert set(SSH_ENV_KEYS) <= ALLOWED_KEYS
    assert "ssh_port" in NUMERIC_KEYS


def test_default_ssh_dir_sits_under_the_mirage_home(tmp_path):
    assert default_ssh_dir(tmp_path) == tmp_path / "ssh"
