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

import pytest

from mirage.cli import main as main_module
from mirage.cli.client import DaemonUnreachable
from mirage.server.daemon_config import DaemonConfigError


def test_an_unreachable_daemon_is_one_line_and_exit_one(monkeypatch, capsys):
    def down() -> None:
        raise DaemonUnreachable("daemon not reachable at http://x")

    monkeypatch.setattr(main_module, "app", down)
    with pytest.raises(SystemExit) as exc:
        main_module.main()
    assert exc.value.code == 1
    assert capsys.readouterr().err == "daemon not reachable at http://x\n"


def test_a_bad_config_is_one_line_and_exit_two(monkeypatch, capsys):
    def bad() -> None:
        raise DaemonConfigError("unknown key: nope")

    monkeypatch.setattr(main_module, "app", bad)
    with pytest.raises(SystemExit) as exc:
        main_module.main()
    assert exc.value.code == 2
    assert capsys.readouterr().err == "unknown key: nope\n"
