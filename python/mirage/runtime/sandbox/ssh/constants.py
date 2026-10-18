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

from mirage.utils.quote import single_quote

ASYNCSSH_HINT = (
    "the ssh runtime needs asyncssh; install with: pip install mirage-ai[ssh]"
)


def wrap_line(line: str, env: dict[str, str], cwd: str) -> str:
    """The line dressed to run on the remote host: cwd, env, then sh.

    SSH exec has no docker-style ``-w``/``-e`` (the protocol's env
    channel is AcceptEnv-gated server-side, so it silently drops
    names), so the working directory and the merged environment ride
    the command itself: ``cd 'cwd' && env 'K=V' ... sh -c 'line'``.
    Every piece is single-quoted for sh, so the remote login shell reads
    each as one word whatever it holds; the machine only needs a
    POSIX-compatible shell.

    Args:
        line (str): the raw shell line.
        env (dict[str, str]): the merged environment.
        cwd (str): the working directory, passed through verbatim.
    """
    parts = ["cd", single_quote(cwd), "&&", "env"]
    parts += [single_quote(f"{key}={value}") for key, value in env.items()]
    parts += ["sh", "-c", single_quote(line)]
    return " ".join(parts)
