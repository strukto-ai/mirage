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


def test_routing_types_import_without_loading_the_runtime():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; from mirage.runtime.routing import RouteDecision; "
            "assert 'mirage.runtime.base' not in sys.modules; "
            "assert 'mirage.runtime.routing.decide' not in sys.modules; "
            "from mirage.runtime.base import Runtime",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
