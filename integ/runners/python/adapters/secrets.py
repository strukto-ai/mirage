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

import os
import tempfile
from collections.abc import Awaitable, Callable

from pydantic import BaseModel, ConfigDict

from mirage.secrets.errors import SecretsError
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret


async def _noop() -> None:
    return None


class CounterConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class DeadConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


async def fetch_dead(config: DeadConfig, ref: str) -> ResolvedSecret:
    raise SecretsError("vault sealed")


def build_secrets_env(
        kind: str) -> tuple[dict[str, object], Callable[[], Awaitable[None]]]:
    """The env plane a secrets target declares, plus its cleanup.

    Registers the counting fake (fresh per-ref counters per open, so the
    counts inside fetched values are deterministic within one target
    run and prove how many times each secret was fetched), materializes
    the dotenv file the `dotenv` entry points at (its path exists only
    at run time, which is why the block is built here and not spelled
    in targets.json), and seeds the process variable the `env` entry
    reads. ``kind`` "dead" is a separate target on purpose: a whole-env
    command fetches every unfetched name, so one dead source would fail
    the healthy target's `env` case. ``kind`` "gated" is one pointer on
    a source that always fails, behind the target's denying profile:
    only a dead source can prove a refused command never fetched, and
    it needs its own target so the deny and the extra pending name
    cannot leak into the other batteries. ``kind`` "implicit" manages
    the names read with no ``$NAME`` in the text (``HOME`` for a tilde
    and a bare ``cd``, ``OLDPWD`` for ``cd -``, ``CDPATH`` for a
    relative ``cd``, ``OPTIND`` and ``OPTERR`` for ``getopts``) plus
    ``ARITH_BOUND``
    for the arithmetic value chase and the ``ARITH_HOP``/``ARITH_END``
    pair, whose first value names the second so only a replan after
    the fetch can reach it; they need their own target because
    any whole-env case would fetch them first and each case would then
    prove nothing, and the directory values name the target's mount
    root so ``cd`` lands on a real directory. The dotenv file carries a
    ``${...}`` value on purpose: values are read verbatim in both
    languages, and interpolating hosts would disagree here.

    Args:
        kind (str): "healthy", "dead", "gated" or "implicit", the
            target's `secrets` value.
    """
    if kind == "dead":
        register_secrets("dead", DeadConfig, fetch_dead)
        return {
            "DEAD": {
                "from": "dead",
                "ref": "x"
            },
            "DEAD2": {
                "from": "dead",
                "ref": "y"
            },
        }, _noop
    if kind == "gated":
        register_secrets("gated", DeadConfig, fetch_dead)
        return {"GATED": {"from": "gated", "ref": "z"}}, _noop
    if kind == "implicit":
        os.environ["MIRAGE_INTEG_HOME_DIR"] = "/data"
        os.environ["MIRAGE_INTEG_OLDPWD_DIR"] = "/data"
        os.environ["MIRAGE_INTEG_CDPATH_DIR"] = "/data"
        os.environ["MIRAGE_INTEG_OPTIND_START"] = "1"
        os.environ["MIRAGE_INTEG_OPTERR"] = "0"
        os.environ["MIRAGE_INTEG_ARITH_BOUND"] = "7"
        os.environ["MIRAGE_INTEG_ARITH_HOP"] = "ARITH_END"
        os.environ["MIRAGE_INTEG_ARITH_END"] = "9"
        return {
            "HOME": {
                "from": "env",
                "key": "MIRAGE_INTEG_HOME_DIR"
            },
            "OLDPWD": {
                "from": "env",
                "key": "MIRAGE_INTEG_OLDPWD_DIR"
            },
            "CDPATH": {
                "from": "env",
                "key": "MIRAGE_INTEG_CDPATH_DIR"
            },
            "OPTIND": {
                "from": "env",
                "key": "MIRAGE_INTEG_OPTIND_START"
            },
            "OPTERR": {
                "from": "env",
                "key": "MIRAGE_INTEG_OPTERR"
            },
            "ARITH_BOUND": {
                "from": "env",
                "key": "MIRAGE_INTEG_ARITH_BOUND"
            },
            "ARITH_HOP": {
                "from": "env",
                "key": "MIRAGE_INTEG_ARITH_HOP"
            },
            "ARITH_END": {
                "from": "env",
                "key": "MIRAGE_INTEG_ARITH_END"
            },
        }, _noop
    counts: dict[str, int] = {}

    async def fetch_counting(config: CounterConfig,
                             ref: str) -> ResolvedSecret:
        counts[ref] = counts.get(ref, 0) + 1
        n = counts[ref]
        return ResolvedSecret(fields={
            "token": f"tok{n}",
            "user": f"u{n}",
            "pass": f"p{n}",
        })

    register_secrets("counter", CounterConfig, fetch_counting)
    os.environ["MIRAGE_INTEG_ENV_SECRET"] = "from-process-env"
    dotfile = tempfile.NamedTemporaryFile(mode="w",
                                          suffix=".env",
                                          delete=False)
    dotfile.write("DOTFILE_SECRET=from-dotenv\n"
                  "DOTFILE_TEMPLATE=${DOTFILE_SECRET}-lit\n")
    dotfile.close()

    async def cleanup() -> None:
        os.unlink(dotfile.name)

    env: dict[str, object] = {
        "APP_NAME": "integ",
        "EDITOR": {
            "value": "vi",
            "readonly": True
        },
        "TOKEN": {
            "from": "counter",
            "ref": "tok",
            "key": "token"
        },
        "DB_USER": {
            "from": "counter",
            "ref": "db",
            "key": "user"
        },
        "DB_PASS": {
            "from": "counter",
            "ref": "db",
            "key": "pass"
        },
        "EAGER_PAIR": {
            "from": "counter",
            "ref": "pair",
            "key": "token",
            "fetch": "eager"
        },
        "LAZY_PAIR": {
            "from": "counter",
            "ref": "pair",
            "key": "user"
        },
        "FROM_ENV": {
            "from": "env",
            "key": "MIRAGE_INTEG_ENV_SECRET"
        },
        "FROM_DOTFILE": {
            "from": "dotenv",
            "ref": dotfile.name,
            "key": "DOTFILE_SECRET"
        },
        "FROM_DOTFILE_LITERAL": {
            "from": "dotenv",
            "ref": dotfile.name,
            "key": "DOTFILE_TEMPLATE"
        },
        "FN_TOKEN": {
            "from": "counter",
            "ref": "fn",
            "key": "token"
        },
        "IND_TOKEN": {
            "from": "counter",
            "ref": "ind",
            "key": "token"
        },
        "ALIAS_TOKEN": {
            "from": "counter",
            "ref": "alias",
            "key": "token"
        },
        "CLEAN_TOKEN": {
            "from": "counter",
            "ref": "clean",
            "key": "token"
        },
        "REDEF_TOKEN": {
            "from": "counter",
            "ref": "redef",
            "key": "token"
        },
        "APPEND_TOKEN": {
            "from": "counter",
            "ref": "app",
            "key": "token"
        },
    }
    return env, cleanup
