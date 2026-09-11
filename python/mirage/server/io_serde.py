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

from dataclasses import asdict
from typing import Any

from mirage.io.types import IOResult
from mirage.provision.types import ProvisionResult


async def io_result_to_dict(
        result: IOResult | ProvisionResult | None) -> dict[str, Any]:
    """Materialize an IOResult into a JSON-friendly dict.

    Falls back to ``result.model_dump()`` for ``ProvisionResult`` (which
    uses pydantic), so the same helper handles both ``mirage provision``
    and normal execute outputs.

    Args:
        result (IOResult | ProvisionResult | None): the
            workspace.execute return value.

    Returns:
        dict[str, Any]: serializable response payload.
    """
    if isinstance(result, IOResult):
        stdout = await result.materialize_stdout()
        stderr = await result.materialize_stderr()
        return {
            "kind":
            "io",
            "exit_code":
            result.exit_code,
            "stdout":
            stdout.decode(errors="replace"),
            "stderr":
            stderr.decode(errors="replace"),
            "refusal":
            (asdict(result.refusal) if result.refusal is not None else None),
        }
    if isinstance(result, ProvisionResult):
        return {"kind": "provision", **result.model_dump()}
    return {"kind": "raw", "value": str(result)}
