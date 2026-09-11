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
from pydantic import BaseModel, ValidationError, field_validator

from mirage.secrets.summary import (MAX_LISTED_FIELDS, error_summary,
                                    field_summary)


def test_field_summary_lists_a_secret_sized_secret():
    assert field_summary({"credential": "x", "username": "u"}, "op") == \
        "{credential, username}"


def test_field_summary_lists_nothing_for_an_empty_secret():
    assert field_summary({}, "op") == "{}"


def test_field_summary_lists_up_to_the_cap():
    fields = {f"f{i:02d}": "v" for i in range(MAX_LISTED_FIELDS)}
    assert field_summary(fields, "op") == "{" + ", ".join(sorted(fields)) + "}"


def test_field_summary_counts_a_process_environment_instead():
    fields = {f"f{i:02d}": "v" for i in range(MAX_LISTED_FIELDS + 1)}
    summary = field_summary(fields, "op")
    assert summary == f"{MAX_LISTED_FIELDS + 1} fields"
    assert "f00" not in summary


def test_field_summary_never_lists_the_process_environment():
    """A hardened container starts from `env -i` plus a handful of
    credentials, so a count threshold alone would recite exactly the
    environment worth hiding."""
    fields = {"HOME": "/root", "AWS_SESSION_TOKEN": "t"}
    assert field_summary(fields, "env") == "2 fields"
    assert "AWS_SESSION_TOKEN" not in field_summary(fields, "env")


class Refusing(BaseModel):
    port: int
    token: str = ""

    @field_validator("token")
    @classmethod
    def _v_token(cls, value: str) -> str:
        if value.startswith("sk-"):
            raise ValueError(f"a live key is not allowed here: {value}")
        return value


def refusal(**fields) -> ValidationError:
    with pytest.raises(ValidationError) as caught:
        Refusing(**fields)
    return caught.value


def test_error_summary_names_the_field_and_the_type_only():
    assert error_summary(refusal(port="x")) == "port: int_parsing"


def test_error_summary_never_carries_the_input():
    """Pydantic renders the refused value as `input_value`, and the
    field validator above spells it inside its own message. Neither
    may reach a 400 body."""
    secret = "sk-live-SUPERSECRET"
    summary = error_summary(refusal(port=1, token=secret))
    assert summary == "token: value_error"
    assert "SUPERSECRET" not in summary


def test_error_summary_joins_every_issue():
    assert error_summary(refusal(
        port="x", token="sk-1")) == ("port: int_parsing; token: value_error")
