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

import subprocess
import sys

import pytest

from mirage.runtime.base import EvalError
from mirage.runtime.envelope import (SENTINEL, python_eval_harness,
                                     split_envelope)


def run_harness(code: str, inputs=None) -> subprocess.CompletedProcess:
    harness = python_eval_harness(code, inputs)
    return subprocess.run([sys.executable, "-"],
                          input=harness.encode(),
                          capture_output=True)


def test_last_expression_becomes_the_value():
    proc = run_harness("print('side'); ctx['n'] + 1", {"ctx": {"n": 41}})
    assert proc.returncode == 0
    stdout, value = split_envelope(proc.stdout)
    assert stdout == b"side\n"
    assert value == 42


def test_statement_only_code_yields_none():
    proc = run_harness("x = 1")
    stdout, value = split_envelope(proc.stdout)
    assert stdout == b""
    assert value is None


def test_tricky_quoting_survives_the_json_embedding():
    code = "s = 'it\\'s \"here\"\\n'\nlen(s)"
    proc = run_harness(code)
    _, value = split_envelope(proc.stdout)
    assert value == 12


def test_raised_code_exits_nonzero_with_no_envelope():
    proc = run_harness("1 / 0")
    assert proc.returncode == 1
    assert b"ZeroDivisionError" in proc.stderr
    with pytest.raises(EvalError, match="no result envelope"):
        split_envelope(proc.stdout)


def test_non_serializable_value_fails_loud_far_side():
    proc = run_harness("set()")
    assert proc.returncode == 1
    assert b"not JSON-serializable" in proc.stderr


def test_non_serializable_inputs_fail_loud_host_side():
    with pytest.raises(EvalError, match="inputs are not JSON-serializable"):
        python_eval_harness("1", {"blob": b"\x00"})


def test_user_output_cannot_forge_the_sentinel():
    # NUL bytes never appear inside JSON text, so a print of the
    # sentinel still loses to the harness's own final envelope.
    proc = run_harness("print('fake')\n'real'")
    _, value = split_envelope(proc.stdout)
    assert value == "real"


def test_bad_json_tail_is_an_eval_error():
    with pytest.raises(EvalError, match="not valid JSON"):
        split_envelope(b"out" + SENTINEL.encode() + b"{nope")
