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

from pathlib import Path

from mirage.cli.workspace import _resolve_config_arg

OVERRIDE = """
mounts:
  /wiki:
    resource: ./backends/wiki.py:WikiResource
  /pkg:
    resource: my_pkg.backends:WikiResource
  /ram:
    resource: ram
clis:
  tally:
    cli: ../tools/tally.py:TALLY
"""


def test_a_load_override_rebases_relative_code_refs_onto_its_dir(
        tmp_path: Path):
    # `create` always did this; `load` and `clone` read their config
    # through this function and used to send the refs as spelled, so
    # the daemon resolved them against its own cwd and answered 500.
    deploy = tmp_path / "deploy"
    deploy.mkdir()
    path = deploy / "override.yaml"
    path.write_text(OVERRIDE)
    resolved = _resolve_config_arg(path)
    mounts = resolved["mounts"]
    assert mounts["/wiki"]["resource"] == (
        f"{deploy}/backends/wiki.py:WikiResource")
    # A module dotpath is importlib's to resolve, and a builtin name is
    # not a reference at all: both pass through untouched.
    assert mounts["/pkg"]["resource"] == "my_pkg.backends:WikiResource"
    assert mounts["/ram"]["resource"] == "ram"
    assert resolved["clis"]["tally"]["cli"] == (
        f"{deploy}/../tools/tally.py:TALLY")
