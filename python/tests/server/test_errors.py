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

import errno
from typing import Literal

import pytest
from pydantic import BaseModel, ConfigDict, ValidationError

from mirage.errors.types import FsCondition
from mirage.policy.errors import PolicyDenied
from mirage.server.errors import (
    ERRNO_CODE,
    STATUS,
    ErrorCode,
    HttpError,
    fs_error,
    loader_error,
    validation_error,
)
from mirage.types import JsonValue, Refusal


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str
    count: int = 0
    mode: Literal["read", "write"] = "read"
    tags: list[str] = []


def _first(body: JsonValue, under: tuple[str, ...] = ()) -> JsonValue:
    with pytest.raises(ValidationError) as caught:
        Body.model_validate(body)
    return validation_error(caught.value.errors(), under).body()["error"]


def test_every_code_answers_one_status_and_every_errno_a_code():
    assert set(STATUS) == set(ErrorCode)
    assert set(ERRNO_CODE) == set(FsCondition)


def test_the_first_declared_field_wins_and_unknown_keys_come_last():
    assert _first({"zz": 1, "count": "x", "name": 5}) == {
        "code": "invalid_value",
        "message": "name must be a string",
        "param": "name",
    }
    assert _first({"zz": 1, "count": "x"}) == {
        "code": "missing_field",
        "message": "name is required",
        "param": "name",
    }
    assert _first({"yy": 1, "zz": 1, "name": "a"}) == {
        "code": "unknown_field",
        "message": "yy is not a known field",
        "param": "yy",
    }


def test_a_message_names_the_choices_never_the_value():
    error = _first({"name": "a", "mode": "secret-value"})
    assert error == {
        "code": "invalid_value",
        "message": "mode must be one of read, write",
        "param": "mode",
    }
    assert "secret-value" not in str(
        _first({"name": "secret-value", "tags": [3]})
    )


def test_a_nested_param_is_a_dotted_path():
    assert _first({"name": "a", "tags": ["x", 3]}, ("config",)) == {
        "code": "invalid_value",
        "message": "config.tags[1] must be a string",
        "param": "config.tags[1]",
    }


def test_a_key_named_like_a_type_keeps_its_name():
    assert _first({"name": "a", "str": 1}) == {
        "code": "unknown_field",
        "message": "str is not a known field",
        "param": "str",
    }


def test_a_body_that_is_not_an_object_names_no_field():
    assert _first([1]) == {
        "code": "invalid_request",
        "message": "body must be a JSON object",
    }


def test_a_loader_error_keeps_its_own_text():
    error = loader_error(ValueError("unknown profile 'x'"))
    assert (error.status, error.body()) == (
        400,
        {
            "error": {
                "code": "invalid_request",
                "message": "unknown profile 'x'",
            }
        },
    )


def test_optional_fields_appear_only_when_set():
    error = HttpError(
        ErrorCode.INVALID_REQUEST, "add aws first", missing=["aws"]
    )
    assert error.body() == {
        "error": {
            "code": "invalid_request",
            "message": "add aws first",
            "missing": ["aws"],
        }
    }


@pytest.mark.parametrize(
    "exc",
    [
        RuntimeError("backend token=secret"),
        ValueError("backend token=secret"),
        OSError("backend token=secret"),
        OSError(errno.ECONNREFUSED, "backend token=secret", "/private/config"),
    ],
)
def test_unknown_failures_hide_backend_details(exc):
    assert fs_error(exc).record() == {
        "code": "internal",
        "message": "internal server error",
    }


@pytest.mark.parametrize(
    "number, name, code, message",
    [
        (errno.ENOENT, "ENOENT", "not_found", "No such file or directory"),
        (errno.EACCES, "EACCES", "forbidden", "Permission denied"),
        (errno.EDQUOT, "EDQUOT", "storage_full", "Disk quota exceeded"),
        (errno.EIO, "EIO", "internal", "Input/output error"),
    ],
)
def test_known_failures_expose_only_public_errno_text(
    number, name, code, message
):
    exc = OSError(number, "backend token=secret", "/private/config")
    assert fs_error(exc).record() == {
        "code": code,
        "message": message,
        "errno": name,
    }


def test_failure_keeps_the_policy_refusal_record():
    exc = PolicyDenied(
        "backend token=secret",
        refusal=Refusal(kind="pending", reason="sign-off", ask_id="abc123"),
    )
    assert fs_error(exc).record() == {
        "code": "policy_refused",
        "message": "Permission denied",
        "errno": "EACCES",
        "refusal": {
            "kind": "pending",
            "reason": "sign-off",
            "policy": "",
            "ask_id": "abc123",
        },
    }
