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
import shlex
from collections.abc import Callable, Sequence
from typing import Any, ClassVar

from mirage.runtime.base import RunArgs, RunResult, Runtime
from mirage.runtime.route.types import RouteScript
from mirage.runtime.sandbox.config import SandboxConfig
from mirage.runtime.sandbox.constants import (DEFAULT_WORKSPACE_ROOT,
                                              MOUNT_SPEC_ENV, SYSTEM_MOUNTS)


class RemoteSandbox(Runtime):
    """A runtime that runs whole lines inside a remote sandbox.

    Subclasses adapt one provider by implementing the hooks
    (create_sandbox, exec_line, upload, download, close); everything
    else is inherited: routing and captures, per-line scripts, lazy
    provisioning on the first line, workspace mounting, and reattach
    to a live sandbox by id. The sandbox is created on the first line,
    never at workspace construction.

    Args:
        captures (Sequence[str]): commands that place a whole line
            here; ("*",) claims every line.
        api_key (str | None): provider credential; None reads the
            provider's own environment variable.
        config (SandboxConfig | dict[str, Any] | None): how the
            sandbox machine is built, coerced through the provider's
            own config class (config_cls), so a field the provider
            does not have fails loud; the dict form is a yaml entry's
            ``config`` block.
        sandbox_id (str | None): reattach to this live sandbox
            instead of creating one.
        workspace_root (str | None): where the workspace appears
            inside the sandbox. None resolves through
            default_workspace_root() on the first line, so each
            provider lands somewhere its sandbox user can write
            (Daytona: $HOME/workspace). The workspace becomes visible
            by running mirage inside the sandbox and FUSE-mounting each
            remotable mount (S3 today) live, so reads and writes flow
            both ways with no sync. This needs an image or snapshot
            with fuse3 and mirage-ai[s3,fuse] installed.
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
                 api_key: str | None = None,
                 config: SandboxConfig | dict[str, Any] | None = None,
                 sandbox_id: str | None = None,
                 workspace_root: str | None = None,
                 script: RouteScript | None = None) -> None:
        self.captures = tuple(captures)
        self.api_key = api_key
        self.config = self.config_cls.coerce(config)
        self.workspace_root = workspace_root
        self.script = script
        self._sandbox_id = sandbox_id
        # True only when this runtime created the sandbox itself:
        # close() must delete only what it created, so reattaching by
        # sandbox_id never destroys a sandbox someone else owns.
        self.owned_sandbox = False
        self._started = False
        self._start_lock = asyncio.Lock()
        self._dispatch: Callable[..., Any] | None = None
        self._mount_specs: Callable[[], dict[str, dict[str, Any]
                                             | None]] | None = None

    @property
    def sandbox_id(self) -> str | None:
        """The live sandbox id, None before the first line runs."""
        return self._sandbox_id

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
        """Run one raw line in the sandbox, provisioning it lazily.

        The first line creates the sandbox (or reattaches when a
        sandbox_id was given) and mounts the workspace; every line
        then executes with the session environment merged over the
        sandbox environment and the cwd resolved under workspace_root.

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
                if self._sandbox_id is None:
                    self._sandbox_id = await self.create_sandbox()
                    self.owned_sandbox = True
                else:
                    await self.connect_sandbox(self._sandbox_id)
                if self.workspace_root is None:
                    self.workspace_root = await self.default_workspace_root()
                await self.mount_workspace()
                self._started = True
        merged = {**self.config.env, **env}
        return await self.exec_line(line, stdin, merged, self.sandbox_cwd(cwd))

    def sandbox_cwd(self, cwd: str) -> str:
        """The session cwd as a path inside the sandbox.

        Args:
            cwd (str): the workspace-side working directory.
        """
        root = self.workspace_root or DEFAULT_WORKSPACE_ROOT
        return posixpath.join(root, cwd.lstrip("/"))

    async def default_workspace_root(self) -> str:
        """The workspace_root when none was given, provider-resolved.

        Called once, after the sandbox is live and before the
        workspace mounts, so adapters can ask the sandbox itself
        (e.g. $HOME) for a directory its user can write.
        """
        return DEFAULT_WORKSPACE_ROOT

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
        root = self.workspace_root or DEFAULT_WORKSPACE_ROOT
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

    async def mount_workspace(self) -> None:
        """Mount the workspace's backends inside the sandbox, once.

        Each user mount becomes one in-sandbox mirage command through
        the provider's own exec API: ``mirage mount add <prefix>
        --fuse <path>``, with the spec in the exec environment (never
        a file). The sandbox then serves ``<workspace_root>/<prefix>``
        live; keeping paths consistent beyond the rebased cwd is the
        caller's job. Needs an image with mirage baked in (e.g.
        mirage-python-fuse). Subclasses may replace this wholesale
        (e.g. a provider volume).
        """
        if self._dispatch is None or self._mount_specs is None:
            return
        for prefix, (spec, mountpoint) in self._desired_mounts().items():
            await self._mount_command(
                f"mirage mount add {shlex.quote(prefix)} "
                f"--fuse {shlex.quote(mountpoint)}",
                {MOUNT_SPEC_ENV: json.dumps(spec)})

    async def _mount_command(self, command: str, env: dict[str, str]) -> None:
        """One in-sandbox mount command, failing loud.

        Args:
            command (str): the mirage mount CLI line to run.
            env (dict[str, str]): extra environment for the line (the
                mount spec rides here, never on disk or argv).
        """
        result = await self.exec_line(command, None, env, "/")
        if result.exit_code != 0:
            detail = (result.stderr
                      or result.stdout).decode(errors="replace").strip()
            raise RuntimeError(
                "the in-sandbox mirage mount failed (sandbox runtimes "
                "need an image with mirage installed, e.g. "
                f"mirage-python-fuse): {detail}")

    async def create_sandbox(self) -> str:
        """Create the provider sandbox and return its id."""
        raise NotImplementedError

    async def connect_sandbox(self, sandbox_id: str) -> None:
        """Reattach to a live provider sandbox.

        Args:
            sandbox_id (str): the id given at construction.
        """
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

    async def upload(self, path: str, data: bytes) -> None:
        """Write one file inside the sandbox.

        Args:
            path (str): the sandbox-side absolute path.
            data (bytes): the file content.
        """
        raise NotImplementedError

    async def download(self, path: str) -> bytes:
        """Read one file from the sandbox.

        Args:
            path (str): the sandbox-side absolute path.
        """
        raise NotImplementedError
