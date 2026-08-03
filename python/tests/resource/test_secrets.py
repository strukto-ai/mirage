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

from pydantic import BaseModel, SecretStr

from mirage.resource.secrets import (REDACTED_SECRET, has_redacted_secret,
                                     redacted_config_dump,
                                     revealed_config_dump)


class Inner(BaseModel):
    token: SecretStr
    host: str = "h"


class Outer(BaseModel):
    name: str
    auth: Inner
    accounts: list[Inner] = []
    note: str | None = None


def sample() -> Outer:
    return Outer(name="x",
                 auth=Inner(token=SecretStr("s1")),
                 accounts=[Inner(token=SecretStr("s2"))])


def test_redacted_dump_recurses_into_nested_models():
    data = redacted_config_dump(sample())
    assert data["auth"]["token"] == REDACTED_SECRET
    assert data["accounts"][0]["token"] == REDACTED_SECRET
    assert data["auth"]["host"] == "h"
    assert data["name"] == "x"


def test_revealed_dump_recurses_into_nested_models():
    data = revealed_config_dump(sample())
    assert data["auth"]["token"] == "s1"
    assert data["accounts"][0]["token"] == "s2"


def test_has_redacted_secret_detects_nested_sentinels():
    assert has_redacted_secret(redacted_config_dump(sample()))
    assert not has_redacted_secret(revealed_config_dump(sample()))


def test_top_level_secret_fields_still_redact():
    data = redacted_config_dump(Inner(token=SecretStr("s")))
    assert data == {"token": REDACTED_SECRET, "host": "h"}
    assert revealed_config_dump(Inner(token=SecretStr("s")))["token"] == "s"
