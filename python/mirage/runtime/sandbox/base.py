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
import json
import posixpath
from collections.abc import Callable, Sequence
from typing import Any, ClassVar

from mirage.runtime.base import RunArgs, RunResult, Runtime
from mirage.runtime.route.types import RouteScript
from mirage.runtime.sandbox.config import SandboxConfig
from mirage.runtime.sandbox.constants import (DEFAULT_WORKSPACE_ROOT,
                                              SANDBOX_WORKSPACE_ID,
                                              SYSTEM_MOUNTS,
                                              WORKSPACE_CONFIG_ENV)


class RemoteSandbox(Runtime):
    """A runtime that runs whole lines inside a sandbox the user runs.

    Mirage never creates or deletes sandboxes: you bring your own
    (a running container, a live Daytona or E2B sandbox) and the
    provider config says how to reach it. Subclasses adapt one
    provider by implementing connect() and exec_line(); everything
    else is inherited: routing and captures, per-line scripts,
    one-time workspace mounting on the first captured line, and the
    cwd rebase.

    Args:
        captures (Sequence[str]): commands that place a whole line
            here; ("*",) claims every line.
        config (SandboxConfig | dict[str, Any] | None): how to reach
            the sandbox, coerced through the provider's own config
            class (config_cls), so a field the provider does not have
            fails loud; the dict form is a yaml entry's ``config``
            block.
        workspace_root (str | None): where the workspace appears
            inside the sandbox (/workspace when omitted); pick a
            directory the sandbox user can write. The workspace
            becomes visible by running mirage inside the sandbox and
            FUSE-mounting each remotable mount live, so reads and
            writes flow both ways with no sync. This needs an image
            with fuse3 and mirage-ai[<backends>,fuse] installed.
        script (RouteScript | None): per-line admission script, the
            same contract as any runtime.
    """

    runs_lines = True
    captures: tuple[str, ...] = ("*", )
    # Each provider's config class; coerce() makes unknown fields
    # fail loud, so providers need no per-field rejection code.
    config_cls: ClassVar[type[SandboxConfig]] = SandboxConfig

    def __init__(self,
                 captures: Sequence[str] = ("*", ),
                 config: SandboxConfig | dict[str, Any] | None = None,
                 workspace_root: str | None = None,
                 script: RouteScript | None = None) -> None:
        self.captures = tuple(captures)
        self.config = self.config_cls.coerce(config)
        self.workspace_root = workspace_root or DEFAULT_WORKSPACE_ROOT
        self.script = script
        # The mount-once latch: the first captured line connects and
        # mounts the workspace; later lines just execute.
        self._started = False
        self._start_lock = asyncio.Lock()
        self._dispatch: Callable[..., Any] | None = None
        self._mount_specs: Callable[[], dict[str, dict[str, Any]
                                             | None]] | None = None

    def attach(
        self,
        dispatch: Callable[..., Any],
        mount_prefixes: Callable[[], list[str]],
        mount_specs: Callable[[], dict[str, dict[str, Any] | None]]
        | None = None,
    ) -> None:
        """Receive the workspace bridge for workspace mounting.

        Args:
            dispatch (Callable): the workspace op dispatch.
            mount_prefixes (Callable): the workspace mount lister; the
                shared runtime contract carries it for the interpreter
                runtimes, but a sandbox needs only the spec map, whose
                keys already name every mount.
            mount_specs (Callable | None): per-prefix remote mount
                specs (a resource's remote_mount_spec()), used to
                reproduce the mounts in the sandbox.
        """
        self._dispatch = dispatch
        self._mount_specs = mount_specs

    async def run(self, args: RunArgs) -> RunResult:
        raise NotImplementedError(
            f"runtime {self.name!r} runs whole lines in a remote sandbox, "
            f"not single interpreter stages")

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        """Run one raw line in the sandbox, mounting the workspace once.

        The first captured line connects to the user's sandbox and
        mounts the workspace; every line then executes with the
        session environment merged over the config environment and the
        cwd resolved under workspace_root.

        The line itself runs verbatim: mounts appear at
        ``<workspace_root>/<prefix>``, so paths relative to the session
        cwd resolve for free, and absolute paths are the caller's
        responsibility (mirage does not rewrite them).

        Args:
            line (str): the raw typed line.
            stdin (bytes | None): bytes piped into the line.
            env (dict[str, str]): the session environment.
            cwd (str): the session working directory.
        """
        async with self._start_lock:
            if not self._started:
                await self.connect()
                await self.mount_workspace()
                self._started = True
        merged = {**self.config.env, **env}
        return await self.exec_line(line, stdin, merged, self.sandbox_cwd(cwd))

    def sandbox_cwd(self, cwd: str) -> str:
        """The session cwd as a path inside the sandbox.

        Args:
            cwd (str): the workspace-side working directory.
        """
        return posixpath.join(self.workspace_root, cwd.lstrip("/"))

    def _desired_mounts(self) -> dict[str, tuple[dict[str, Any], str]]:
        """The workspace's user mounts as (spec, sandbox mountpoint).

        The spec map's keys name every mount, so no separate mount
        lister is needed. System mounts (/dev, the history view) are
        excluded: the sandbox has its own, and they are host
        machinery, not user data. A user mount with no spec fails
        loud.
        """
        assert self._mount_specs is not None
        specs = {
            raw.rstrip("/") or "/": spec
            for raw, spec in self._mount_specs().items()
        }
        prefixes = set(specs) - SYSTEM_MOUNTS
        # A bare "/" next to real mounts is the synthetic default root,
        # not a user mount; walk it only when it is the whole world.
        if len(prefixes) > 1:
            prefixes.discard("/")
        root = self.workspace_root
        desired: dict[str, tuple[dict[str, Any], str]] = {}
        for prefix in sorted(prefixes):
            spec = specs.get(prefix)
            if spec is None:
                raise ValueError(
                    f"mount {prefix!r} is not remotely mountable; "
                    f"sandbox runtimes FUSE-mount remote-backed mounts")
            mountpoint = (root if prefix == "/" else posixpath.join(
                root, prefix.lstrip("/")))
            desired[prefix] = (spec, mountpoint)
        return desired

    def _workspace_config(self) -> dict[str, Any]:
        """The in-sandbox workspace config mirroring the host mounts."""
        mounts: dict[str, Any] = {}
        for prefix, (spec, mountpoint) in self._desired_mounts().items():
            mounts[prefix] = {**spec, "fuse": mountpoint}
        return {"mode": "EXEC", "mounts": mounts}

    async def mount_workspace(self) -> None:
        """Mount the workspace inside the sandbox, once.

        Mirage is workspace based, so the sandbox gets exactly one
        workspace mirroring the host mounts: one in-sandbox ``mirage
        workspace create`` through the provider's own exec API, with
        the config in the exec environment (never a file). The
        sandbox's daemon then serves ``<workspace_root>/<prefix>``
        live; keeping paths consistent beyond the rebased cwd is the
        caller's job. Needs an image with mirage baked in (e.g.
        mirage-python-fuse). Subclasses may replace this wholesale
        (e.g. a provider volume).
        """
        if self._dispatch is None or self._mount_specs is None:
            return
        config = self._workspace_config()
        # Recreate idempotently: a stale workspace from an earlier
        # attach is dropped, and the line's exit code is create's.
        command = (
            f"mirage workspace delete {SANDBOX_WORKSPACE_ID} "
            f">/dev/null 2>&1; "
            f"mirage workspace create --id {SANDBOX_WORKSPACE_ID} --from-env")
        result = await self.exec_line(
            command, None, {WORKSPACE_CONFIG_ENV: json.dumps(config)}, "/")
        if result.exit_code != 0:
            detail = (result.stderr
                      or result.stdout).decode(errors="replace").strip()
            raise RuntimeError(
                "the in-sandbox mirage workspace create failed (sandbox "
                "runtimes need an image with mirage installed, e.g. "
                f"mirage-python-fuse): {detail}")

    async def connect(self) -> None:
        """Attach to the user's live sandbox, failing loud if absent."""
        raise NotImplementedError

    async def exec_line(self, line: str, stdin: bytes | None,
                        env: dict[str, str], cwd: str) -> RunResult:
        """Execute one shell line inside the sandbox.

        Args:
            line (str): the raw shell line.
            stdin (bytes | None): bytes piped into the line.
            env (dict[str, str]): the merged environment.
            cwd (str): the sandbox-side working directory.
        """
        raise NotImplementedError
