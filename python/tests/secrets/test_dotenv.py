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

from mirage.secrets.config import DotenvConfig
from mirage.secrets.dotenv import fetch_dotenv
from mirage.secrets.errors import SecretsError


@pytest.mark.asyncio
async def test_fetch_dotenv_reads_the_ref_path(tmp_path):
    file = tmp_path / "creds.env"
    file.write_text("TOKEN=abc\nBARE\nQUOTED='x y'\n", encoding="utf-8")
    secret = await fetch_dotenv(DotenvConfig(), str(file))
    assert secret.fields["TOKEN"] == "abc"
    assert secret.fields["QUOTED"] == "x y"
    assert "BARE" not in secret.fields
    assert secret.expires_at is None


@pytest.mark.asyncio
async def test_fetch_dotenv_empty_ref_falls_back_to_config_path(tmp_path):
    file = tmp_path / ".env"
    file.write_text("A=1\n", encoding="utf-8")
    secret = await fetch_dotenv(DotenvConfig(path=str(file)), "")
    assert secret.fields == {"A": "1"}


@pytest.mark.asyncio
async def test_fetch_dotenv_missing_file_names_the_path(tmp_path):
    missing = tmp_path / "nope.env"
    with pytest.raises(SecretsError, match=r"nope\.env"):
        await fetch_dotenv(DotenvConfig(), str(missing))


@pytest.mark.asyncio
async def test_fetch_dotenv_never_interpolates(tmp_path, monkeypatch):
    monkeypatch.setenv("HOST_TOKEN", "host-secret")
    file = tmp_path / "creds.env"
    file.write_text("API_TOKEN=${HOST_TOKEN}\nA=x\nB=${A}-y\nC=$A\n",
                    encoding="utf-8")
    secret = await fetch_dotenv(DotenvConfig(), str(file))
    assert secret.fields == {
        "API_TOKEN": "${HOST_TOKEN}",
        "A": "x",
        "B": "${A}-y",
        "C": "$A",
    }
