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

from pydantic import BaseModel, ConfigDict, SecretStr

from mirage.vfs.secrets import (REDACTED_SECRET, has_redacted_secret,
                                redacted_config_dump, revealed_config_dump)


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


class ProviderConfig(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    access_token: SecretStr | Callable[[], str | SecretStr] | None = None
    host: str = "h"


def test_a_provider_callable_redacts_instead_of_crashing():
    # msgraph and google both accept a token provider, and pydantic
    # cannot serialize a function: dumping the model raised
    # PydanticSerializationError and took the whole snapshot with it.
    data = redacted_config_dump(ProviderConfig(access_token=lambda: "tok"))
    assert data == {"access_token": REDACTED_SECRET, "host": "h"}


def test_a_provider_callable_is_never_revealed():
    # Revealing one would mean calling it and freezing a token that
    # expires into a snapshot that does not.
    data = revealed_config_dump(ProviderConfig(access_token=lambda: "tok"))
    assert data["access_token"] == REDACTED_SECRET


def test_a_provider_config_still_reports_a_redacted_secret():
    # This is what routes the mount down the fresh-VFS path at load.
    assert has_redacted_secret(
        redacted_config_dump(ProviderConfig(access_token=lambda: "tok")))


def test_an_absent_secret_stays_none():
    assert redacted_config_dump(ProviderConfig())["access_token"] is None


# An alias VFS (MinIO, R2, ...) saves its own config under its parent's
# `type`, so a class resolved from the type names the wrong fields; the scan
# reads every value instead, as the TypeScript `hasRedactedSecret` does.
def test_a_redacted_value_is_found_whatever_the_field_is_called():
    assert has_redacted_secret({
        "access_key_id": REDACTED_SECRET,
        "bucket": "b"
    })
    assert not has_redacted_secret({"access_key_id": "k", "bucket": "b"})
