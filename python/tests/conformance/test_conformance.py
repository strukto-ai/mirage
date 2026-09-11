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

import base64
import json
import os
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.resource.redis import RedisResource

REPO_ROOT = Path(__file__).resolve().parents[3]
CONFORMANCE_DIR = REPO_ROOT / "conformance"
REDIS_URL = os.environ.get("REDIS_URL", "")
SUPPORTED_MATRIX = {
    "python": {"ram", "disk", "redis"},
    "typescript": {"ram", "disk", "redis"},
}


def _decode_bytes(record: dict, text_key: str, base64_key: str) -> bytes:
    has_text = text_key in record
    has_base64 = base64_key in record
    if has_text == has_base64:
        raise ValueError(
            f"record must set exactly one of {text_key}/{base64_key}: "
            f"{record}")
    if has_text:
        return record[text_key].encode()
    return base64.b64decode(record[base64_key])


def _load_seeds() -> dict[str, bytes]:
    raw = json.loads((CONFORMANCE_DIR / "seeds.json").read_text())
    return {
        path: _decode_bytes(spec, "text", "base64")
        for path, spec in raw.items()
    }


def _validate_matrix(case: dict, spec_name: str) -> None:
    matrix = case["matrix"]
    unknown_languages = set(matrix) - set(SUPPORTED_MATRIX)
    if unknown_languages:
        names = ", ".join(sorted(unknown_languages))
        raise ValueError(
            f"case {case['id']} in {spec_name} has unknown matrix "
            f"language(s): {names}")

    for language, backends in matrix.items():
        unsupported = set(backends) - SUPPORTED_MATRIX[language]
        if unsupported:
            names = ", ".join(sorted(unsupported))
            raise ValueError(
                f"case {case['id']} in {spec_name} has unsupported "
                f"{language} backend(s): {names}")

    if not any(matrix.values()):
        raise ValueError(
            f"case {case['id']} in {spec_name} applies to no backend")

    # A case is a parity claim, so the two languages have to be asked the
    # same question. Dropping a backend from one side reads as coverage
    # while it is really an unexamined divergence -- and it is invisible,
    # because the side that still lists the backend goes green. Anything
    # genuinely language-specific says so in a `divergence` key, which the
    # README calls the per-backend override.
    # A non-empty string, not merely a present key: `"divergence": null`
    # or `""` would otherwise buy the exemption while explaining nothing,
    # which is the one thing the key exists to supply.
    divergence = case.get("divergence")
    if not (isinstance(divergence, str) and divergence.strip()):
        python_backends = set(matrix.get("python", []))
        typescript_backends = set(matrix.get("typescript", []))
        if python_backends != typescript_backends:
            only_python = ", ".join(
                sorted(python_backends - typescript_backends)) or "none"
            only_typescript = ", ".join(
                sorted(typescript_backends - python_backends)) or "none"
            raise ValueError(
                f"case {case['id']} in {spec_name} has an asymmetric "
                f"matrix (python-only: {only_python}; typescript-only: "
                f"{only_typescript}). Run it on both, or record why it "
                f"cannot with a `divergence` key.")


def _load_cases() -> list[dict]:
    cases = []
    for spec_path in sorted((CONFORMANCE_DIR / "cases").glob("*.json")):
        doc = json.loads(spec_path.read_text())
        for case in doc["cases"]:
            _validate_matrix(case, spec_path.name)
            cases.append(case)
    return cases


SEEDS = _load_seeds()
CASES = _load_cases()


def _params() -> list:
    params = []
    for case in CASES:
        for backend in case["matrix"].get("python", []):
            marks = []
            if backend == "redis" and not REDIS_URL:
                marks.append(pytest.mark.skip(reason="REDIS_URL not set"))
            params.append(
                pytest.param(backend,
                             case,
                             id=f"{backend}-{case['id']}",
                             marks=marks))
    return params


async def _build_workspace(
        backend: str, tmp_path: Path,
        case_id: str) -> tuple[Workspace, RedisResource | None]:
    if backend == "ram":
        return Workspace({"/": RAMResource()}, mode=MountMode.WRITE), None
    if backend == "disk":
        return Workspace({"/": DiskResource(root=str(tmp_path))},
                         mode=MountMode.WRITE), None
    if backend == "redis":
        resource = RedisResource(url=REDIS_URL,
                                 key_prefix=f"test:conformance:{case_id}:")
        await resource._store.clear()
        return Workspace({"/": resource}, mode=MountMode.WRITE), resource
    raise ValueError(f"unknown python backend in matrix: {backend}")


async def _seed(ws: Workspace) -> None:
    made: set[str] = set()
    for path, content in SEEDS.items():
        parts = [p for p in path.rsplit("/", 1)[0].split("/") if p]
        for depth in range(1, len(parts) + 1):
            directory = "/" + "/".join(parts[:depth])
            if directory not in made:
                made.add(directory)
                await ws.fs.mkdir(directory)
        await ws.fs.write(path, content)


@pytest.mark.asyncio
@pytest.mark.parametrize(("backend", "case"), _params())
async def test_conformance(backend: str, case: dict, tmp_path: Path) -> None:
    ws, resource = await _build_workspace(backend, tmp_path, case["id"])
    try:
        await _seed(ws)
        stdin = None
        if "stdin_text" in case or "stdin_base64" in case:
            stdin = _decode_bytes(case, "stdin_text", "stdin_base64")
        result = await ws.execute(case["cmd"], stdin=stdin)
        stdout = await result.materialize_stdout()
        stderr = await result.materialize_stderr()
        expect = case["expect"]
        assert result.exit_code == expect["exit"]
        assert stdout == _decode_bytes(expect, "stdout_text", "stdout_base64")
        assert stderr == _decode_bytes(expect, "stderr_text", "stderr_base64")
    finally:
        if resource is not None:
            await resource._store.clear()
            await resource._store.close()


@pytest.mark.parametrize(
    ("matrix", "message"),
    [
        ({
            "pyhton": ["ram"]
        }, "unknown matrix language"),
        ({
            "typescript": ["s3"]
        }, "unsupported typescript backend"),
        ({
            "python": [],
            "typescript": []
        }, "applies to no backend"),
    ],
)
def test_validate_matrix_rejects_invalid_targets(matrix: dict,
                                                 message: str) -> None:
    case = {"id": "invalid_matrix", "matrix": matrix}
    with pytest.raises(ValueError, match=message):
        _validate_matrix(case, "invalid.json")


def test_validate_matrix_accepts_supported_targets() -> None:
    case = {
        "id": "valid_matrix",
        "matrix": {
            "python": ["ram", "disk", "redis"],
            "typescript": ["ram", "disk", "redis"],
        },
    }
    _validate_matrix(case, "valid.json")


def test_validate_matrix_rejects_an_asymmetric_matrix() -> None:
    case = {
        "id": "narrowed_matrix",
        "matrix": {
            "python": ["ram", "disk", "redis"],
            "typescript": ["ram"],
        },
    }
    with pytest.raises(ValueError, match="asymmetric matrix"):
        _validate_matrix(case, "narrowed.json")


def test_validate_matrix_allows_an_asymmetric_matrix_that_says_why() -> None:
    case = {
        "id": "declared_divergence",
        "matrix": {
            "python": ["ram", "disk", "redis"],
            "typescript": ["ram"],
        },
        "divergence": "TypeScript has no redis-backed foo yet (#1234).",
    }
    _validate_matrix(case, "declared.json")


@pytest.mark.parametrize("value", [None, "", "   ", True, 1, []])
def test_validate_matrix_rejects_an_empty_divergence(value: object) -> None:
    """The key has to carry the reason, not merely exist.

    A null or blank value would buy the exemption while explaining
    nothing, which is the one thing it is there to supply -- and it would
    read as a considered decision in review.
    """
    case = {
        "id": "blank_divergence",
        "matrix": {
            "python": ["ram", "disk", "redis"],
            "typescript": ["ram"],
        },
        "divergence": value,
    }
    with pytest.raises(ValueError, match="asymmetric matrix"):
        _validate_matrix(case, "blank.json")
