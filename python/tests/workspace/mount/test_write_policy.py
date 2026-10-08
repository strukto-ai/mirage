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

import json
import subprocess
import sys
from pathlib import Path

import pytest

from mirage.types import MountMode, WritePolicy
from mirage.vfs.base import BaseVFS
from mirage.vfs.loader import load_attr
from mirage.vfs.registry import REGISTRY, known_vfs_names
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace.mount.write_policy import (
    WRITE_CONDITIONS,
    check_write_capability,
    coerce_write_policy,
    write_conditions,
)

_FIXTURES = Path(__file__).parents[4] / "integ" / "fixtures" / "write"
_CONDITIONS = json.loads((_FIXTURES / "conditions.json").read_text())
_VERDICTS = json.loads((_FIXTURES / "verdicts.json").read_text())["cases"]


def _stub(name: str) -> BaseVFS:
    # The real class, unconfigured; an s3 one gets AWS's endpoint.
    cls = load_attr(REGISTRY[name].vfs_path)
    vfs = cls.__new__(cls)
    vfs.name = name
    if isinstance(vfs, S3VFS):
        vfs.config = S3Config(
            bucket="b", endpoint_url="https://s3.amazonaws.com"
        )
    return vfs


@pytest.mark.parametrize(
    "value, expected",
    [
        (None, WritePolicy.UNCONDITIONAL),
        ("", WritePolicy.UNCONDITIONAL),
        ("conditional", WritePolicy.CONDITIONAL),
        ("CONDITIONAL", WritePolicy.CONDITIONAL),
        # The config door coerces once, then the mount coerces the member again.
        (WritePolicy.CONDITIONAL, WritePolicy.CONDITIONAL),
        ("staged", WritePolicy.STAGED),
    ],
)
def test_a_declared_write_policy_coerces(value, expected):
    assert coerce_write_policy(value) is expected


def test_an_unknown_write_policy_names_the_choices():
    with pytest.raises(ValueError) as info:
        coerce_write_policy("banana")
    assert str(info.value) == (
        "unknown write policy 'banana'; expected one of: "
        "unconditional, conditional, staged"
    )


def test_the_condition_table_is_the_shared_fixture_both_ways():
    rows = _CONDITIONS["vfs"]
    assert rows
    assert {k: sorted(v) for k, v in WRITE_CONDITIONS.items()} == {
        k: sorted(v) for k, v in rows.items() if v
    }


def test_every_registered_vfs_has_a_condition_row_and_no_row_is_stale():
    names = set(known_vfs_names())
    assert names
    # The browser's own backend (opfs) is checked by the browser twin.
    assert set(_CONDITIONS["vfs"]) - set(_CONDITIONS["browser_only"]) == names


_MINIO = "http://127.0.0.1:9000"


@pytest.mark.parametrize(
    "env, declared, expected",
    [
        (
            {"AWS_ENDPOINT_URL_S3": "http://minio.local:9000"},
            {},
            "s3+endpoint",
        ),
        ({"AWS_ENDPOINT_URL": "http://minio.local:9000"}, {}, "s3+endpoint"),
        (
            {"AWS_ENDPOINT_URL_S3": "", "AWS_ENDPOINT_URL": _MINIO},
            {},
            "s3+endpoint",
        ),
        (
            {
                "AWS_ENDPOINT_URL_S3": "http://minio.local:9000",
                "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS": "true",
            },
            {},
            "s3",
        ),
        ({}, {}, "s3"),
        ({}, {"endpoint_url": _MINIO}, "s3+endpoint"),
        ({}, {"endpoint_url": "https://s3.us-west-2.amazonaws.com"}, "s3"),
        ({}, {"endpoint_url": "https://s3.cn-north-1.amazonaws.com.cn"}, "s3"),
    ],
    ids=[
        "service-env",
        "global-env",
        "empty-service-env",
        "ignored",
        "aws",
        "declared-custom",
        "declared-regional",
        "declared-china",
    ],
)
def test_an_s3_mount_is_judged_on_its_declared_endpoint(
    monkeypatch, env, declared, expected
):
    # The declared endpoint, else the env.
    for name in (
        "AWS_ENDPOINT_URL",
        "AWS_ENDPOINT_URL_S3",
        "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
    ):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    vfs = S3VFS(S3Config(bucket="b", region="us-east-1", **declared))
    want = (
        _CONDITIONS["s3+endpoint"]
        if expected == "s3+endpoint"
        else _CONDITIONS["vfs"]["s3"]
    )
    assert write_conditions(vfs) == frozenset(want)


@pytest.mark.parametrize("case", _VERDICTS, ids=[c["name"] for c in _VERDICTS])
def test_the_verdict_matches_the_shared_fixture(case):
    args = (
        "/x/",
        _stub(case["vfs"]),
        coerce_write_policy(case["policy"]),
        MountMode(case["mode"]),
        case["caches"],
    )
    if case["expect"] is None:
        check_write_capability(*args)
        return
    with pytest.raises(ValueError) as info:
        check_write_capability(*args)
    assert str(info.value) == case["expect"]


_NO_S3_EXTRA_PROBE = """
import sys


class _Blocker:

    def find_spec(self, name, path=None, target=None):
        if name.split(".")[0] in ("aioboto3", "aiobotocore", "botocore"):
            raise ModuleNotFoundError(name)
        return None


sys.meta_path.insert(0, _Blocker())

from mirage import RAMVFS, Workspace  # noqa: F401
"""


def test_the_write_policy_needs_no_s3_extra_to_import():
    proc = subprocess.run(
        [sys.executable, "-c", _NO_S3_EXTRA_PROBE],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
