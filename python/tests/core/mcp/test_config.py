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
from pydantic import ValidationError

from mirage.core.mcp.config import MCPAuth, MCPConfig


def test_auth_is_optional():
    assert MCPConfig(url="http://x/mcp").auth is None


@pytest.mark.parametrize(
    "auth",
    [
        {"type": "header", "token": "t"},
        {"type": "bearer", "token": "t", "name": "x-api-key"},
        {"type": "header", "name": "x-api-key:", "token": "t"},
        {"type": "header", "name": "x\r\nevil: 1", "token": "t"},
        {"type": "basic", "token": "t"},
        {"type": "bearer", "token": "t", "extra": 1},
    ],
)
def test_an_auth_block_that_cannot_build_one_header_is_refused(auth):
    with pytest.raises(ValidationError):
        MCPConfig(url="http://x/mcp", auth=auth)


def test_the_token_never_prints():
    config = MCPConfig(
        url="http://x/mcp", auth={"type": "bearer", "token": "s3cr3t"}
    )
    assert "s3cr3t" not in repr(config)


@pytest.mark.parametrize(
    "token",
    [
        "",
        "s3cr3t\n",
        "s3cr3t\x00",
        " s3cr3t",
        "s3cr3t ",
        "s3cr3t\x7f",
        "sécret",
    ],
)
def test_a_token_no_header_can_carry_is_refused_unprinted(token):
    with pytest.raises(ValidationError) as caught:
        MCPConfig(url="http://x/mcp", auth={"type": "bearer", "token": token})
    assert "s3cr3t" not in str(caught.value)


def test_a_token_with_a_space_inside_is_taken():
    config = MCPConfig(
        url="http://x/mcp", auth={"type": "bearer", "token": "a b"}
    )
    assert config.auth.token.get_secret_value() == "a b"


def test_a_refused_auth_never_prints_its_token_alone():
    with pytest.raises(ValidationError) as caught:
        MCPAuth(type="bearer", token="s3cr3t\n")
    assert "s3cr3t" not in str(caught.value)


def test_a_refused_auth_block_never_prints_its_token():
    with pytest.raises(ValidationError) as caught:
        MCPConfig(
            url="http://x/mcp",
            auth={"type": "bearer", "token": "s3cr3t", "name": "x"},
        )
    assert "s3cr3t" not in str(caught.value)
