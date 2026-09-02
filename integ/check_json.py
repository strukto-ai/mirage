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
"""Assert a probe's JSON result matches a truth file.

Usage: <command> 2>&1 | python integ/check_json.py integ/truth_x.json

The probe emits its result as a single-line JSON object; this picks the
last such line out of the captured stream, so surrounding log noise and
tracebacks do not break the check. Every key in the truth file must be
present and compare equal; extra keys in the result are ignored, which is
what lets a probe report volatile values (a generated mountpoint, a raw
mount table row) without asserting on them.

Unlike check_lines.sh this compares values, not substrings: a truth of
16 no longer matches a result of 166, and true is distinct from "yes".
"""

import json
import sys
from collections import deque
from typing import TextIO

# Enough of a traceback to name the failure without pasting a whole run.
TAIL_LINES = 40


def load_expected(path: str) -> dict:
    """Read the truth file.

    Args:
        path (str): path to the JSON truth file.

    Returns:
        dict: the expected keys and values.
    """
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def find_actual(stream: TextIO) -> tuple[dict | None, list[str]]:
    """Return the last single-line JSON object, and the noise around it.

    The tail is kept because a probe that died has its reason in it. The
    stream is consumed here, so anything this function drops is gone:
    reporting only "no JSON result" made every crash look alike, whether
    the probe threw on import, refused a platform, or never ran.

    Args:
        stream (TextIO): the captured probe output.

    Returns:
        tuple[dict | None, list[str]]: the parsed result, or None if the
        probe emitted none, and the last lines that were not it.
    """
    found = None
    tail: deque[str] = deque(maxlen=TAIL_LINES)
    for line in stream:
        text = line.strip()
        if text.startswith("{"):
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                value = None
            if isinstance(value, dict):
                found = value
                continue
        if text:
            tail.append(text)
    return found, list(tail)


def main() -> int:
    truth = sys.argv[1]
    expected = load_expected(truth)
    actual, tail = find_actual(sys.stdin)
    if actual is None:
        print(f"FAIL: {truth} not satisfied (no JSON result in output)",
              file=sys.stderr)
        if tail:
            print(f"--- last {len(tail)} lines the probe printed ---",
                  file=sys.stderr)
            for line in tail:
                print(line, file=sys.stderr)
        else:
            print("--- the probe printed nothing at all ---", file=sys.stderr)
        return 1
    rc = 0
    matched = 0
    for key, want in expected.items():
        if key not in actual:
            print(f"MISSING: {key}", file=sys.stderr)
            rc = 1
        elif actual[key] != want:
            print(f"MISMATCH: {key} expected {want!r}, got {actual[key]!r}",
                  file=sys.stderr)
            rc = 1
        else:
            matched += 1
    if rc:
        print(f"FAIL: {truth} not satisfied", file=sys.stderr)
    else:
        print(f"OK: {truth} ({matched} keys matched)")
    return rc


if __name__ == "__main__":
    sys.exit(main())
