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

import importlib.util

import pytest

from mirage.agents.hermes.credentials import HermesSecrets, through_hermes
from mirage.config import WorkspaceConfig, load_config
from mirage.utils.yaml import parse_yaml

NEEDS_S3 = pytest.mark.skipif(
    importlib.util.find_spec("aioboto3") is None,
    reason="an S3 mount needs the mirage-ai[s3] extra",
)
PROFILE = {
    "KEY": "k",
    "SECRET": "s",
    "TOKEN": "t",
    "DSN": "postgresql://u:p@h/d",
    "BARE_DSN": "postgresql://u@h/d",
}
BASE = "processes: workspace\nmounts:\n  /tmp: {vfs: ram, mode: write}\n"


def read(extra: str) -> tuple[WorkspaceConfig, HermesSecrets]:
    secrets = HermesSecrets(PROFILE.get)
    config = load_config(parse_yaml(BASE + extra), env=secrets)
    return through_hermes(config, secrets), secrets


def test_names_and_pointers_read_the_profile_and_route_to_hermes():
    config, secrets = read(
        "  /s3:\n    vfs: s3\n    config:\n      bucket: b\n"
        "      aws_access_key_id: ${KEY}\n"
        "      aws_secret_access_key: {from: env, key: SECRET}\n"
        "env:\n  TOKEN: {from: env}\n"
    )
    assert dict(secrets) == {"KEY": "k", "SECRET": "s", "TOKEN": "t"}
    s3 = config.mounts["/s3"].config
    assert s3["aws_access_key_id"] == "k"
    assert s3["aws_secret_access_key"] == {"from": "hermes", "key": "SECRET"}
    assert config.env["TOKEN"].provider == "hermes"


def test_a_session_profile_env_entry_routes_to_hermes():
    config, secrets = read(
        "profiles:\n  dev:\n    env:\n      T: {from: env, key: TOKEN}\n"
    )
    assert config.profiles["dev"].env["T"].provider == "hermes"
    assert dict(secrets) == {"TOKEN": "t"}


def test_a_name_the_profile_lacks_is_refused():
    with pytest.raises(ValueError, match="hermes config set"):
        read("env:\n  GONE: {from: env}\n")


REFUSED = {
    "a secrets block": (
        "secrets:\n  vault: {source: dotenv}\n",
        "secrets:",
    ),
    "a dotenv pointer": (
        "  /s:\n    vfs: slack\n"
        "    config: {token: {from: dotenv, key: SLACK}}\n",
        "from: dotenv",
    ),
    "a 1password env entry": (
        "env:\n  OP: {from: 1password, ref: 'op://v/i'}\n",
        "env.OP",
    ),
    "s3 with no keys": pytest.param(
        "  /s3: {vfs: s3, config: {bucket: b}}\n",
        "no key pair",
        marks=NEEDS_S3,
    ),
    "s3 with a profile": (
        "  /s3:\n    vfs: s3\n    config: {bucket: b, aws_profile: dev}\n",
        "aws_profile",
    ),
    "an s3 alias with no keys": pytest.param(
        "  /r2: {vfs: r2, config: {bucket: b, account_id: a}}\n",
        "no key pair",
        marks=NEEDS_S3,
    ),
    "ssh": (
        "  /h: {vfs: ssh, config: {host: h}}\n",
        "ssh-agent",
    ),
    "chroma": (
        "  /c: {vfs: chroma, config: {collection_name: c}}\n",
        "CHROMA_",
    ),
    "a google refresh token": (
        "  /g: {vfs: gdrive, config: {refresh_token: '${TOKEN}'}}\n",
        "refresh the OAuth token",
    ),
    "postgres with no password": (
        "  /p: {vfs: postgres, config: {dsn: 'postgresql://u@h/d'}}\n",
        "pgpass",
    ),
    "a postgres pointer with no password": (
        "  /p: {vfs: postgres, config: {dsn: {from: env, key: BARE_DSN}}}\n",
        "pgpass",
    ),
    "a session profile's dotenv entry": (
        "profiles:\n  dev:\n    env:\n      T: {from: dotenv, key: T}\n",
        "profiles.dev.env.T",
    ),
    "a policy program's env pointer": (
        "route_policy:\n  script: 'print(1)'\n"
        "  env: {T: {from: env, key: TOKEN}}\n",
        "route_policy",
    ),
    "a session profile program's env pointer": (
        "profiles:\n  dev:\n    policy:\n      pre_command:\n"
        "        - {script: 'print(1)', env: {T: {from: env, key: TOKEN}}}\n",
        "profiles.dev.policy",
    ),
    "a backend named by its class": (
        "  /h: {vfs: 'mirage.vfs.ssh:SSHVFS', config: {host: h}}\n",
        "outside Mirage's own list",
    ),
    "a mongodb aws login": (
        "  /m: {vfs: mongodb, config: "
        "{uri: 'mongodb://h/?authMechanism=MONGODB-AWS'}}\n",
        "MONGODB-AWS",
    ),
    "lancedb on gcs with no options": (
        "  /l: {vfs: lancedb, config: {uri: 'gcs://b/x'}}\n",
        "storage_options",
    ),
    "lancedb cloud with no key": (
        "  /l: {vfs: lancedb, config: {uri: 'db://x'}}\n",
        "LANCEDB_API_KEY",
    ),
    "an ssh machine": (
        "machines:\n  box: {provider: ssh, host: h}\n",
        "machines.box",
    ),
    "a kubernetes machine": (
        "machines:\n  k: {provider: kubernetes, pod: p}\n",
        "kube",
    ),
    "an e2b machine with no key": (
        "machines:\n  e: {provider: e2b}\n",
        "no api_key",
    ),
    "an s3 sessions store with no keys": (
        "store:\n  sessions: {type: s3, bucket: b}\n",
        "store.sessions",
    ),
}


@pytest.mark.parametrize("extra,reason", REFUSED.values(), ids=REFUSED.keys())
def test_a_key_reached_around_hermes_is_refused(extra, reason):
    with pytest.raises(
        ValueError, match="takes keys only from Hermes"
    ) as info:
        read(extra)
    assert reason in str(info.value)


ALLOWED = {
    "s3 with keys": "  /s3:\n    vfs: s3\n    config: {bucket: b, "
    "aws_access_key_id: '${KEY}', aws_secret_access_key: '${SECRET}'}\n",
    "a google access token": "  /g: {vfs: gdrive, config: "
    "{access_token: '${TOKEN}'}}\n",
    "postgres with a password": "  /p: {vfs: postgres, config: "
    "{dsn: 'postgresql://u:${SECRET}@h/d'}}\n",
    "postgres with a password in the query": "  /p: {vfs: postgres, "
    "config: {dsn: 'postgresql://u@h/d?password=${SECRET}'}}\n",
    "a postgres pointer with a password": "  /p: {vfs: postgres, config: "
    "{dsn: {from: env, key: DSN}}}\n",
    "an e2b machine with a key": "machines:\n  e: {provider: e2b, "
    "api_key: '${KEY}'}\n",
    "a docker machine": "machines:\n  d: {provider: docker, container: c}\n",
}


@pytest.mark.parametrize("extra", ALLOWED.values(), ids=ALLOWED.keys())
def test_a_key_hermes_hands_over_is_allowed(extra):
    read(extra)
