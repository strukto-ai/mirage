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
import threading
import time

import pytest
from typer.testing import CliRunner

from mirage.cli.context import (
    check_name,
    current_name,
    local_url,
    login_path,
    read_contexts,
    resolve_workspace,
    update_contexts,
    write_contexts,
)
from mirage.cli.credentials import Login, write_login
from mirage.cli.errors import ContextError
from mirage.cli.main import app
from mirage.cli.settings import load_daemon_settings
from mirage.cli.types import Context, Contexts


def _stored(url: str) -> Login:
    return Login(url=url, access_token="from-login", logged_in_at=time.time())


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    for name in (
        "MIRAGE_CONTEXT",
        "MIRAGE_WORKSPACE",
        "MIRAGE_DAEMON_URL",
        "MIRAGE_DAEMON_PORT",
        "MIRAGE_TOKEN",
    ):
        monkeypatch.setenv(name, "")
    return tmp_path


def test_only_local_is_current_with_no_file():
    contexts = read_contexts()
    assert list(contexts.contexts) == ["local"]
    assert current_name(contexts) == "local"


def test_env_context_wins_and_an_unknown_one_is_refused(monkeypatch):
    write_contexts(
        Contexts(contexts={"dev": Context(url="https://dev.example")})
    )
    monkeypatch.setenv("MIRAGE_CONTEXT", "dev")
    assert current_name(read_contexts()) == "dev"
    monkeypatch.setenv("MIRAGE_CONTEXT", "nope")
    with pytest.raises(ContextError, match="no context 'nope'"):
        current_name(read_contexts())


def test_the_file_is_the_owners_only(home):
    write_contexts(read_contexts())
    assert (home / "contexts.json").stat().st_mode & 0o777 == 0o600


def test_a_name_must_be_safe_as_a_file_name():
    assert check_name("dev.example-1") == "dev.example-1"
    for bad in ("../up", "Dev"):
        with pytest.raises(ContextError):
            check_name(bad)


def test_local_follows_the_daemon_port_after_its_own_url_and_config(
    monkeypatch,
):
    contexts = read_contexts()
    assert local_url({}, contexts) == "http://127.0.0.1:8765"
    assert local_url({"port": 9100}, contexts) == "http://127.0.0.1:9100"
    monkeypatch.setenv("MIRAGE_DAEMON_PORT", "9200")
    assert local_url({"port": 9100}, contexts) == "http://127.0.0.1:9200"
    table = {"url": "http://127.0.0.1:9300"}
    assert local_url(table, contexts) == "http://127.0.0.1:9300"
    contexts.contexts["local"].url = "http://127.0.0.1:9400"
    assert local_url(table, contexts) == "http://127.0.0.1:9400"


def test_a_remote_context_gets_its_login_never_config_tokens(home):
    (home / "config.toml").write_text('[daemon]\nauth_token = "local-only"\n')
    write_contexts(
        Contexts(
            current="dev",
            contexts={"dev": Context(url="https://dev.example", team="acme")},
        )
    )
    assert load_daemon_settings().auth_token == ""
    write_login(_stored("https://dev.example"), login_path("dev"))
    settings = load_daemon_settings()
    assert (settings.context, settings.url, settings.auth_token) == (
        "dev",
        "https://dev.example",
        "",
    )
    assert settings.login.access_token == "from-login"


def test_two_changes_made_at_once_both_stay(home):
    def add(name: str) -> None:
        def change(contexts: Contexts) -> None:
            time.sleep(0.05)
            contexts.contexts[name] = Context(url=f"https://{name}.example")

        update_contexts(change)

    threads = [threading.Thread(target=add, args=(n,)) for n in "ab"]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(read_contexts().contexts) == ["a", "b", "local"]
    assert not (home / "contexts.json.lock").exists()


def test_the_workspace_is_the_flag_then_env_then_the_context(monkeypatch):
    write_contexts(Contexts(contexts={"local": Context(workspace="kept")}))
    assert resolve_workspace(None) == "kept"
    monkeypatch.setenv("MIRAGE_WORKSPACE", "env")
    assert resolve_workspace(None) == "env"
    assert resolve_workspace("flag") == "flag"


def test_no_workspace_selected_gives_a_hint():
    done = CliRunner().invoke(app, ["shell", "-c", "true"])
    assert done.exit_code == 2
    assert "run `mirage workspace use <id>` or pass -w" in done.output


def test_switch_run_once_elsewhere_and_forget(home, monkeypatch):
    write_contexts(
        Contexts(
            contexts={
                "dev": Context(
                    url="https://dev.example", team="acme", workspace="w1"
                )
            }
        )
    )
    write_login(_stored("https://dev.example"), login_path("dev"))
    runner = CliRunner()
    once = runner.invoke(app, ["--context", "dev", "whoami"])
    assert json.loads(once.stdout) | {"renew_by": None} == {
        "context": "dev",
        "url": "https://dev.example",
        "team": "acme",
        "user": None,
        "workspace": "w1",
        "renew_by": None,
    }
    monkeypatch.setenv("MIRAGE_CONTEXT", "")
    assert read_contexts().current == "local"
    assert runner.invoke(app, ["context", "use", "dev"]).exit_code == 0
    assert read_contexts().current == "dev"
    refused = runner.invoke(app, ["context", "use", "nope"])
    assert isinstance(refused.exception, ContextError)
    local = runner.invoke(app, ["context", "delete", "local"])
    assert isinstance(local.exception, ContextError)
    assert runner.invoke(app, ["context", "delete", "dev"]).exit_code == 0
    assert read_contexts().current == "local"
    assert not (home / "logins" / "dev.json").exists()


def test_daemon_config_holds_the_daemon_settings(home):
    runner = CliRunner()
    done = runner.invoke(app, ["daemon", "config", "set", "port", "9100"])
    assert done.exit_code == 0, done.output
    assert "port = 9100" in (home / "config.toml").read_text()
    assert load_daemon_settings().url == "http://127.0.0.1:9100"
    assert runner.invoke(app, ["config", "list"]).exit_code == 2
