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

from pydantic import SecretStr

from mirage.core.ssh.config import SSHConfig
from mirage.resource.secrets import (REDACTED_SECRET, redacted_config_dump,
                                     reveal_secret)


def test_password_and_passphrase_are_secrets():
    cfg = SSHConfig(host="h", password="pw", passphrase="pp")
    assert isinstance(cfg.password, SecretStr)
    assert isinstance(cfg.passphrase, SecretStr)
    assert reveal_secret(cfg.password) == "pw"
    assert reveal_secret(cfg.passphrase) == "pp"


def test_snapshot_state_redacts_both():
    dump = redacted_config_dump(
        SSHConfig(host="h", password="pw", passphrase="pp"))
    assert dump["password"] == REDACTED_SECRET
    assert dump["passphrase"] == REDACTED_SECRET
    assert dump["host"] == "h"


def test_absent_credentials_stay_absent():
    # None, not a redaction marker: an absent credential must not make a
    # snapshot demand a fresh config it never held.
    dump = redacted_config_dump(SSHConfig(host="h"))
    assert dump["password"] is None
    assert dump["passphrase"] is None
