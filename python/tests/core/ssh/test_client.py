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

from mirage.core.ssh.client import _abs, _connect_kwargs, _key
from mirage.resource.ssh.ssh import SSHConfig


def test_key_strips_slash():
    assert _key("/foo/bar") == "foo/bar"
    assert _key("foo") == "foo"


def test_abs_joins_root():
    cfg = SSHConfig(host="dev", root="/home/ubuntu/project")
    assert _abs(cfg, "/src/main.py") == "/home/ubuntu/project/src/main.py"
    assert _abs(cfg, "") == "/home/ubuntu/project"


def test_abs_root_slash():
    cfg = SSHConfig(host="dev", root="/")
    assert _abs(cfg, "/file.txt") == "/file.txt"
    assert _abs(cfg, "") == "/"


def test_connect_kwargs_overrides():
    cfg = SSHConfig(
        host="dev",
        hostname="10.0.0.1",
        port=2222,
        username="admin",
        identity_file="~/.ssh/custom.pem",
    )
    kw = _connect_kwargs(cfg)
    assert kw["host"] == "10.0.0.1"
    assert kw["port"] == 2222
    assert kw["username"] == "admin"


def test_connect_kwargs_defaults():
    cfg = SSHConfig(host="dev")
    kw = _connect_kwargs(cfg)
    assert kw["host"] == "dev"
    assert "port" not in kw
    assert "username" not in kw
    assert kw["known_hosts"] is None
    assert kw["login_timeout"] == 30


def test_connect_kwargs_password_and_passphrase():
    # Both used to be dropped by pydantic's extra="ignore" without a word, so
    # a password-only host and an encrypted key were unreachable.
    cfg = SSHConfig(host="dev",
                    password="pw",
                    identity_file="~/k",
                    passphrase="pp")
    kw = _connect_kwargs(cfg)
    assert kw["password"] == "pw"
    assert kw["passphrase"] == "pp"


def test_connect_kwargs_passphrase_rides_the_identity_file():
    # A passphrase unlocks the named key; with no identity_file there is no
    # key to hand it to, which is the TypeScript accessor's rule as well.
    kw = _connect_kwargs(SSHConfig(host="dev", passphrase="pp"))
    assert "passphrase" not in kw
    assert "password" not in kw
