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

import asyncio
import re

from mirage import MountMode, Workspace
from mirage.vfs.ram import RAMVFS

# An incident-response workspace: the service tree, the runbooks the
# oncall works from, and the credentials nobody reads by hand.
#
# Three roles read the same three mounts and see three different
# filesystems. A role's command tree is read in two steps, and every
# refusal below comes from one of them:
#
#   the name     the tree maps command names to decisions. The root `*`
#                is every command it does not name, so a root deny
#                leaves a role only the commands the tree names.
#   the mount    a mount or folder entry's tree is judged beside the
#                role's own for a line that works inside that path, and
#                the strictest answer wins (deny, then ask, then allow),
#                so it only tightens.
#
# Hiding is neither of these: it is not a refusal at all. A hidden path
# answers ENOENT, so the role never learns the name; a denied path stays
# in the listing and fails when read. /vault is denied for the oncall
# and hidden for the auditor, which is the same three files seen two
# ways.
#
# The third role, the commander, states no root deny, which is how a
# role says "every tool": a command the tree does not decide is allowed.
# Its /vault entry still runs.

VAULT = {
    "decision": "deny",
    "reason": "credentials are never read by hand",
}
NOD = {
    "decision": "ask",
    "reason": "a runbook edit needs a nod",
}

PROFILES = {
    "oncall": {
        "commands": {
            # Every command the tree does not name is refused:
            # `sort: Permission denied`.
            "*": "deny",
            "ls": "allow",
            "cat": "allow",
            "grep": "allow",
            "rm": "allow",
            "cp": "allow",
        },
        "mounts": {
            "/repo": {
                # Modes only ever narrow: the workspace mounts /repo
                # write, and this role reads it.
                "mode": "read",
                # A name pattern written in a mount section is anchored
                # to that mount when the role compiles, so this is
                # every .env under /repo and nothing anywhere else.
                "paths": {"hide": ["*.env"]},
            },
            "/vault": {
                # A named command answers for itself, so each one that
                # could read a credential carries the deny under /vault.
                "commands": {
                    "cat": VAULT,
                    "grep": VAULT,
                    "cp": VAULT,
                },
            },
            "/runbook": {
                # This tree is asked about a line that works inside
                # /runbook, beside the role's own.
                "commands": {
                    "rm": NOD,
                    "cp": NOD,
                },
            },
            "/runbook/frozen": {
                # A folder entry inside a mount: for a frozen file
                # /runbook asks and this one denies, and the stricter
                # answer wins.
                "commands": {
                    "rm": {
                        "decision": "deny",
                        "reason": "the rollback plan is frozen",
                    },
                },
            },
        },
    },
    "auditor": {
        # No rm, no cp: this role cannot be talked into a write, because
        # its tree names neither.
        "commands": {
            "*": "deny",
            "ls": "allow",
            "cat": "allow",
            "grep": "allow",
        },
        # Hidden, where the oncall has it denied. Same mount, same
        # files, two different answers to `ls /vault`.
        "paths": {"hide": ["/vault"]},
    },
    "commander": {
        # No root deny, so every command mirage ships runs, this
        # role's own `sort` and `wc` included. What that does not say
        # is "unrestricted": the /vault entry's `*` denies any command
        # that works inside /vault. No entry narrows a mode, so every
        # mount stays at the mode the workspace declared.
        "mounts": {
            "/vault": {
                "commands": {"*": VAULT},
            },
        },
    },
}

SEED = [
    "mkdir -p /runbook/frozen",
    "echo \"print('serving')\" > /repo/service.py",
    "echo DSN=postgres://localhost/app > /repo/.env",
    "echo '1. page the oncall' > /runbook/steps.md",
    "echo PAGER=cat > /runbook/local.env",
    "echo '1. flip the flag' > /runbook/frozen/rollback.md",
    "echo AKIA-not-a-real-key > /vault/aws.token",
]

LINES = [
    ("oncall", "cat /repo/service.py", "the tree names cat, and allows it"),
    (
        "oncall",
        "sort /repo/service.py",
        "not named, so the root `*` refuses it",
    ),
    ("oncall", "ls /repo", "the hide takes .env out of the listing"),
    ("oncall", "cat /repo/.env", "and answers absence, not refusal"),
    (
        "oncall",
        "cat /runbook/local.env",
        "the same pattern, anchored to /repo, reaches no further",
    ),
    ("oncall", "ls /vault", "a deny leaves the name where it is"),
    (
        "oncall",
        "cat /vault/aws.token",
        "and refuses the read: /vault denies cat",
    ),
    ("oncall", "rm /runbook/steps.md", "rm asks under /runbook"),
    (
        "oncall",
        "rm /runbook/frozen/rollback.md",
        "the folder's tree denies, and the stricter wins",
    ),
    (
        "oncall",
        "cp /vault/aws.token /runbook/steps.md",
        "every path is judged: the source's deny wins",
    ),
    ("oncall", "rm /repo/service.py", "the mount section narrowed the mode"),
    ("auditor", "ls /vault", "hidden here, so the mount is not there at all"),
    (
        "auditor",
        "cat /repo/.env",
        "the hide was the other role's, not the workspace's",
    ),
    ("auditor", "rm /runbook/steps.md", "this tree does not name rm"),
    (
        "commander",
        "sort /repo/service.py",
        "no root deny, so every tool runs",
    ),
    (
        "commander",
        "wc -l /runbook/steps.md",
        "including the ones no other role names",
    ),
    (
        "commander",
        "cat /vault/aws.token",
        "and it is still not unrestricted: the deny runs",
    ),
    (
        "commander",
        "rm /repo/service.py",
        "no /repo entry, so /repo keeps the workspace's write mode",
    ),
]

# The approval id is a digest of the session, cwd and words; it is
# stable, and it is noise here.
ASK_ID = re.compile(r"\(ask [0-9a-f]+\)")


def answer(out: bytes, err: bytes, code: int) -> str:
    """One line's outcome, as a reader of the table wants it: what came
    back, or why nothing did.

    Args:
        out (bytes): the line's stdout.
        err (bytes): the line's stderr.
        code (int): the line's exit code.
    """
    if err:
        first = ASK_ID.sub("(ask ...)", err.decode()).splitlines()[0]
        return f"[{code}] {first}"
    return f"[{code}] {' '.join(out.decode().split())}".rstrip()


async def main() -> None:
    ws = Workspace(
        {
            "/repo/": RAMVFS(),
            "/runbook/": RAMVFS(),
            "/vault/": RAMVFS(),
        },
        mode=MountMode.WRITE,
        profiles=PROFILES,
    )

    # A session that names no role is unrestricted, which is the host's
    # own view and the only place this seeding could run.
    for line in SEED:
        await ws.shell(line)

    for role in PROFILES:
        ws.create_session(role, profile=role)

    for role, line, note in LINES:
        res = await ws.shell(line, session_id=role)
        print(
            f"{role:10} {line:42} "
            f"{answer(res.stdout or b'', res.stderr or b'', res.exit_code)}"
        )
        print(f"{'':10} {'':42} {note}")
    await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
