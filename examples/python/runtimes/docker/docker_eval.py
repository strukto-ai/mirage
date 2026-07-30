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

import asyncio
import json

from mirage.runtime.errors import EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.sandbox.docker import DockerRuntime
from mirage.runtime.types import EvalResult, EvalValue

# How to give YOUR OWN runtime the evaluator capability: inherit
# EvaluatorMixin and implement eval (inputs in, the last expression's
# value out). The transport is yours to choose; mirage only defines
# the contract. Here a docker container evaluates python by piping a
# harness to its stock `python3 -`: the value comes back as JSON
# behind a NUL sentinel on stdout (NUL cannot appear in JSON text, so
# user prints cannot forge it). An evaluator runtime can also serve
# as the workspace's routing policy engine. Start the container first:
#
#     docker run -d --name mirage-eval-demo python:3.12-slim sleep infinity
#
# and remove it when done: docker rm -f mirage-eval-demo

CONTAINER = "mirage-eval-demo"

SENTINEL = "\x00MIRAGE_EVAL\x00"

# Runs inside the container: bind inputs as globals, execute the user
# code, evaluate its trailing expression, emit the value as JSON
# behind the sentinel. User prints stream to stdout ahead of it; a
# raised exception exits nonzero with its own traceback instead.
HARNESS = """\
import ast as _ast
import json as _json
import sys as _sys
_code = _json.loads({code_json})
_tree = _ast.parse(_code)
_last = None
if _tree.body and isinstance(_tree.body[-1], _ast.Expr):
    _last = _ast.Expression(_tree.body[-1].value)
    _tree.body = _tree.body[:-1]
_globals = _json.loads({inputs_json})
exec(compile(_tree, "<eval>", "exec"), _globals)
_value = None
if _last is not None:
    _value = eval(compile(_last, "<eval>", "eval"), _globals)
_sys.stdout.write({sentinel_json} + _json.dumps(_value))
"""


class EvalDockerRuntime(DockerRuntime, EvaluatorMixin):
    """A docker container that is also an evaluator."""

    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        if session is not None:
            raise EvalError("one exec per run; sessions are not supported")
        harness = HARNESS.format(code_json=json.dumps(json.dumps(code)),
                                 inputs_json=json.dumps(
                                     json.dumps(inputs or {})),
                                 sentinel_json=json.dumps(SENTINEL))
        result = await self.run_line("python3 -", harness.encode(), {}, "/")
        if result.exit_code != 0:
            detail = (result.stderr or b"").decode(errors="replace").strip()
            raise EvalError(detail or f"evaluation exited {result.exit_code}")
        stdout, sep, tail = result.stdout.rpartition(SENTINEL.encode())
        if not sep:
            raise EvalError("the program exited before its final expression")
        return EvalResult(value=json.loads(tail.decode()), stdout=stdout)


async def main() -> None:
    runtime = EvalDockerRuntime(config={"container": CONTAINER})

    result = await runtime.eval(
        "print('computing inside the container')\n"
        "sum(ctx['xs']) * ctx['factor']",
        inputs={"ctx": {
            "xs": [1, 2, 3],
            "factor": 7
        }})
    print(f"value: {result.value}")
    print(f"container stdout: {result.stdout.decode()!r}")

    try:
        await runtime.eval("1 / 0")
    except EvalError as exc:
        last_line = str(exc).splitlines()[-1]
        print(f"remote failure surfaces as EvalError: {last_line}")

    await runtime.close()


if __name__ == "__main__":
    asyncio.run(main())
