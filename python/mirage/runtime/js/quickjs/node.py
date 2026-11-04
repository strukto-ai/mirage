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
from importlib.resources import files

# Node's common APIs over qjs's std and os, as a function that takes the
# program's argv and script path. shim.js has a twin in the typescript
# package that must stay byte-identical (test_node.py).
NODE_SHIM = (files("mirage.runtime.js.quickjs") / "shim.js").read_text(
    encoding="utf-8"
)


def node_preamble(argv: list[str], script: str | None) -> str:
    """The source that sets up Node's globals before a program runs.

    Args:
        argv (list[str]): what ``process.argv`` holds: ``node``, the
            script when there is one, then the program's arguments.
        script (str | None): the script's virtual path, which
            ``__filename`` and a relative ``require`` start from; None for
            ``-e`` and piped programs, which start from the working
            directory.
    """
    return (
        f"std.evalScript({json.dumps(NODE_SHIM)})"
        f"({json.dumps(argv)}, {json.dumps(script)});"
    )
