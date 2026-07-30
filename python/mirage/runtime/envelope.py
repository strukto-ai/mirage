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

from mirage.runtime.base import EvalError, EvalValue

# The result envelope: a remote evaluator only speaks the process
# dialect (stdout/stderr/exit), so the value comes home as JSON behind
# this sentinel, appended as the program's final stdout write. NUL
# bytes cannot appear in JSON text, so user output never forges it.
SENTINEL = "\x00MIRAGE_EVAL\x00"

# The far-side harness: binds the inputs as globals, runs the user
# code, captures its LAST EXPRESSION (monty semantics), and emits the
# envelope. User prints stream to stdout ahead of the sentinel; any
# raised exception exits nonzero with its own traceback and no
# envelope.
_HARNESS = """\
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
try:
    _payload = _json.dumps(_value)
except TypeError:
    _sys.stderr.write(
        "eval: result of type %s is not JSON-serializable\\n"
        % type(_value).__name__)
    _sys.exit(1)
_sys.stdout.write({sentinel_json} + _payload)
"""


def python_eval_harness(code: str,
                        inputs: dict[str, EvalValue] | None) -> str:
    """Wrap user code in the far-side envelope harness.

    The harness needs only a stock python3 on the remote side; code
    and inputs travel embedded as JSON literals, so no argument
    quoting is involved.

    Args:
        code (str): the user program; its trailing expression becomes
            the value.
        inputs (dict[str, EvalValue] | None): named globals for the
            program.

    Raises:
        EvalError: the inputs exceed what JSON can carry (e.g. bytes),
            so no remote transport could deliver them.
    """
    try:
        inputs_json = json.dumps(inputs or {})
    except (TypeError, ValueError) as exc:
        raise EvalError(f"eval inputs are not JSON-serializable: {exc}")
    return _HARNESS.format(code_json=json.dumps(json.dumps(code)),
                           inputs_json=json.dumps(inputs_json),
                           sentinel_json=json.dumps(SENTINEL))


def split_envelope(stdout: bytes) -> tuple[bytes, EvalValue]:
    """Split a remote run's stdout into user output and the value.

    Args:
        stdout (bytes): the full stdout of the harness run.

    Raises:
        EvalError: no envelope present (the program never reached the
            final write) or the payload is not valid JSON.
    """
    head, sep, tail = stdout.rpartition(SENTINEL.encode())
    if not sep:
        raise EvalError("evaluation produced no result envelope "
                        "(the program exited before its final expression)")
    try:
        value: EvalValue = json.loads(tail.decode())
    except (UnicodeDecodeError, ValueError) as exc:
        raise EvalError(f"eval result envelope is not valid JSON: {exc}")
    return head, value
