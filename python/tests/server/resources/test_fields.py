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

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field, SecretStr

from mirage.server.resources.fields import dataclass_fields, model_fields


class Auth(BaseModel):
    type: Literal["bearer", "header"]
    token: SecretStr | None = None


class Config(BaseModel):
    url: str = Field(description="Where it is.")
    tags: list[str] = []
    retries: int = 3
    mode: Literal[1, 2] = 1
    auth: Auth | None = None
    hook: Callable[[], None] | None = None


@dataclass
class RuntimeConfig:
    host: str
    port: int = 22
    api_key: str | None = None
    env: dict[str, str] = field(default_factory=dict)


def test_a_model_is_read_as_a_config_writes_it():
    fields = {f["name"]: f for f in model_fields(Config)}
    assert fields["url"] == {
        "name": "url",
        "type": "string",
        "secret": False,
        "required": True,
        "description": "Where it is.",
    }
    assert fields["tags"]["type"] == "list"
    assert fields["retries"]["default"] == 3
    assert fields["mode"]["type"] == "number"
    assert fields["mode"]["options"] == ["1", "2"]
    assert fields["auth.type"]["group"] == "auth"
    assert fields["auth.type"]["options"] == ["bearer", "header"]
    assert fields["auth.token"]["secret"] is True
    assert "hook" not in fields


def test_a_runtime_config_marks_its_credentials_secret():
    fields = {f["name"]: f for f in dataclass_fields(RuntimeConfig)}
    assert fields["host"]["required"] is True
    assert fields["port"] == {
        "name": "port",
        "type": "number",
        "secret": False,
        "required": False,
        "default": 22,
    }
    assert fields["api_key"]["secret"] is True
    assert "env" not in fields
