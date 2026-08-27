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


def _run_probe(probe):
    result = subprocess.run([sys.executable, "-c", probe],
                            capture_output=True,
                            text=True,
                            timeout=30)
    assert result.returncode == 0, result.stderr


def test_cli_import_does_not_load_server_app():
    _run_probe("""
import sys

import mirage.cli.main

assert "mirage.server.app" not in sys.modules
assert "fastapi" not in sys.modules
""")


@pytest.mark.parametrize(("package", "implementation", "name"), [
    ("mirage.server", "mirage.server.app", "build_app"),
    ("mirage.server.auth", "mirage.server.auth.middleware", "AuthMiddleware"),
])
def test_package_root_export_is_lazy(package, implementation, name):
    probe = f"""
import importlib
import sys

package = importlib.import_module({package!r})
assert {implementation!r} not in sys.modules
assert {name!r} in package.__all__
exported = getattr(package, {name!r})
direct = getattr(importlib.import_module({implementation!r}), {name!r})
assert exported is direct
"""
    _run_probe(probe)
