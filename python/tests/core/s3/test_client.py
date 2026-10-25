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

import ast
from pathlib import Path

import pytest

from mirage.core.s3.client import create_s3_client, is_condition_lost
from mirage.vfs.s3.config import S3Config
from tests.core.s3.conftest import LOST_CODES, client_error
from tests.e2e.s3_mock import MultiBucketSession, patch_s3_session

_CASES = LOST_CODES["cases"]


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_only_a_lost_condition_reads_as_lost(case):
    exc = client_error(case["code"], case["status"], "PutObject")
    assert is_condition_lost(exc) is case["lost"]


def test_a_transport_failure_is_not_a_lost_condition():
    assert not is_condition_lost(ConnectionError("reset by peer"))


MIRAGE = Path(__file__).resolve().parents[3] / "mirage"
SEAM = "core/s3/client.py"
# The packages that build an AWS session or client.
SDKS = ("aioboto3", "aiobotocore", "boto3", "botocore.session")
# What only the seam may touch: the session factory the S3 test seam
# patches, and the kwargs it builds a client from.
SEAM_NAMES = frozenset({"async_session", "_client_kwargs"})
# Modules that open another AWS service's client, each with the reason.
KEPT = {
    "secrets/aws.py": "Secrets Manager, not S3, through its own aws_session",
}


def _is_sdk(module: str) -> bool:
    return any(module == sdk or module.startswith(f"{sdk}.") for sdk in SDKS)


def s3_bypasses(source: str) -> list[str]:
    """What one module does to open an S3 client past the seam.

    Args:
        source (str): the module's text.
    """
    found: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.extend(
                f"import {alias.name}"
                for alias in node.names
                if _is_sdk(alias.name)
            )
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            if _is_sdk(node.module):
                found.append(f"from {node.module}")
            found.extend(
                alias.name for alias in node.names if alias.name in SEAM_NAMES
            )
        elif isinstance(node, ast.Attribute) and node.attr in SEAM_NAMES:
            found.append(node.attr)
    return sorted(set(found))


def bypassing_modules(root: Path) -> dict[str, list[str]]:
    """Every module but the seam and the kept ones that opens past it.

    Args:
        root (Path): the package tree to scan.
    """
    offenders: dict[str, list[str]] = {}
    for path in sorted(root.rglob("*.py")):
        name = path.relative_to(root).as_posix()
        if name == SEAM or name in KEPT:
            continue
        found = s3_bypasses(path.read_text(encoding="utf-8"))
        if found:
            offenders[name] = found
    return offenders


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("import aioboto3\n", ["import aioboto3"]),
        ("import boto3.session\n", ["import boto3.session"]),
        (
            "from aiobotocore.session import get_session\n",
            ["from aiobotocore.session"],
        ),
        (
            "from mirage.core.s3.client import async_session\n",
            ["async_session"],
        ),
        (
            "from mirage.core.s3.client import async_session as make\n",
            ["async_session"],
        ),
        (
            "from mirage.core.s3 import client\n"
            "client.async_session(config).client(**client._client_kwargs(c))\n",
            ["_client_kwargs", "async_session"],
        ),
    ],
)
def test_the_guard_catches_a_planted_bypass(source, expected):
    assert s3_bypasses(source) == expected


@pytest.mark.parametrize(
    "source",
    [
        "from mirage.core.s3.client import create_s3_client\n",
        "from botocore.config import Config\n",
        "from botocore.exceptions import ClientError\n",
        "async_sessions = []\n",
    ],
)
def test_the_guard_leaves_what_opens_through_the_seam(source):
    assert s3_bypasses(source) == []


def test_the_guard_fails_on_a_planted_module_and_spares_the_seam(tmp_path):
    (tmp_path / "core" / "s3").mkdir(parents=True)
    (tmp_path / "core" / "s3" / "planted.py").write_text(
        "from mirage.core.s3.client import async_session\n", encoding="utf-8"
    )
    (tmp_path / SEAM).write_text("import aioboto3\n", encoding="utf-8")
    assert bypassing_modules(tmp_path) == {
        "core/s3/planted.py": ["async_session"]
    }


def test_the_guard_still_sees_the_seam_open_its_client():
    seam = (MIRAGE / SEAM).read_text(encoding="utf-8")
    assert s3_bypasses(seam) == ["import aioboto3"]


def test_every_s3_client_opens_through_the_seam():
    assert bypassing_modules(MIRAGE) == {}, (
        "open S3 clients with create_s3_client, so the one test seam "
        "serves every caller"
    )


def test_every_kept_module_still_opens_its_own_client():
    for name in KEPT:
        assert s3_bypasses((MIRAGE / name).read_text(encoding="utf-8"))


@pytest.mark.asyncio
async def test_the_test_seam_serves_every_client():
    session = MultiBucketSession({"b": {}})
    with patch_s3_session(session):
        manager = create_s3_client(S3Config(bucket="b"))
    async with manager as client:
        assert client is session._client
