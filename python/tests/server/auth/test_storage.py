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
import stat

import pytest

from mirage.server.auth.storage import (default_token_file, ensure_token_file,
                                        read_token_file)
from mirage.server.env import ENV_HOME


@pytest.mark.no_host_override
def test_ensure_token_file_creates_with_0o600(tmp_path):
    target = tmp_path / "subdir" / "auth_token"
    token = ensure_token_file(target)
    assert target.exists()
    assert target.read_text().strip() == token
    assert token, "minted token must be non-empty"
    mode = stat.S_IMODE(os.stat(target).st_mode)
    assert mode == 0o600, f"expected 0o600, got {oct(mode)}"


@pytest.mark.no_host_override
def test_ensure_token_file_is_idempotent(tmp_path):
    target = tmp_path / "auth_token"
    first = ensure_token_file(target)
    second = ensure_token_file(target)
    assert first == second, "second call must reuse existing token"


@pytest.mark.no_host_override
def test_read_token_file_returns_none_when_missing(tmp_path):
    target = tmp_path / "absent"
    assert read_token_file(target) is None


@pytest.mark.no_host_override
def test_read_token_file_returns_stripped_contents(tmp_path):
    target = tmp_path / "auth_token"
    target.write_text("  abc-def  \n")
    assert read_token_file(target) == "abc-def"


@pytest.mark.no_host_override
def test_default_token_file_follows_mirage_home(tmp_path, monkeypatch):
    monkeypatch.setenv(ENV_HOME, str(tmp_path))
    assert default_token_file() == tmp_path / "auth_token"
