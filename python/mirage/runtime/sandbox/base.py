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
import re
import shlex
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from mirage.resource.history import HISTORY_PREFIX
from mirage.runtime.base import RunArgs, RunResult, Runtime
from mirage.runtime.route.types import RouteScript

# Virtual mounts the workspace synthesizes; the sandbox has its own.
SYSTEM_MOUNTS: frozenset[str] = frozenset({"/dev", HISTORY_PREFIX})


@dataclass(frozen=True, slots=True)
class SandboxResources:
    """Sandbox sizing, mapped onto each provider's create call.

    Providers that fix sizing in the image or template ignore the
    fields they cannot honor.

    Args:
        cpu (int | None): CPU cores.
        memory (int | None): memory in GiB.
        disk (int | None): disk in GiB.
        gpu (int | str | None): GPU count or type spec, for providers
            that take one.
    """

    cpu: int | None = None
    memory: int | None = None
    disk: int | None = None
    gpu: int | str | None = None


class RemoteSandbox(Runtime):
    """A runtime that runs whole lines inside a remote sandbox.

    Subclasses adapt one provider by implementing the hooks
    (create_sandbox, exec_line, upload, download, close); everything
    else is inherited: routing and captures, per-line scripts, lazy
    provisioning on the first line, workspace mounting, control-plane
    translation of virtual mount paths onto the provider's mountpoints,
    and reattach to a live sandbox by id. The sandbox is created on the
    first line, never at workspace construction.

    Args:
        captures (Sequence[str]): commands that place a whole line
            here; ("*",) claims every line.
        api_key (str | None): provider credential; None reads the
            provider's own environment variable.
        image (str | None): image or template name; None uses the
            provider default.
        env (dict[str, str] | None): environment set in the sandbox.
        resources (SandboxResources | None): sizing, where the
            provider supports per-sandbox resources.
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

    def __init__(self,
                 captures: Sequence[str] = ("*", ),
                 api_key: str | None = None,
                 image: str | None = None,
                 env: dict[str, str] | None = None,
                 resources: SandboxResources | dict[str, Any] | None = None,
                 sandbox_id: str | None = None,
                 workspace_root: str | None = None,
                 script: RouteScript | None = None) -> None:
        self.captures = tuple(captures)
        self.api_key = api_key
        self.image = image
        self.env = dict(env) if env is not None else {}
        # The dict form is the yaml entry's resources block.
        self.resources = (SandboxResources(
            **resources) if isinstance(resources, dict) else resources)
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
        self._mount_prefixes: Callable[[], list[str]] | None = None
        self._mount_specs: Callable[[], dict[str, dict[str, Any]
                                             | None]] | None = None
        # virtual mount prefix -> its physical mountpoint in this sandbox,
        # and the same as MIRAGE_<PREFIX> env vars, both rebuilt per
        # line. mirage is the control plane: the agent speaks virtual
        # paths and these rewrite them onto the provider.
        self._mount_map: dict[str, str] | None = None
        self._mount_env: dict[str, str] = {}
        # prefix -> fingerprint of the mount the sandbox actually has,
        # the reconciler's record of applied state.
        self._applied_mounts: dict[str, str] = {}

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
            mount_prefixes (Callable): the workspace mount lister.
            mount_specs (Callable | None): per-prefix remote mount
                specs (a resource's remote_mount_spec()), used to
                reproduce the mounts in the sandbox.
        """
        self._dispatch = dispatch
        self._mount_prefixes = mount_prefixes
        self._mount_specs = mount_specs

    async def run(self, args: RunArgs) -> RunResult:
        raise NotImplementedError(
            f"runtime {self.name!r} runs whole lines in a remote sandbox, "
            f"not single interpreter stages")

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        """Run one raw line in the sandbox, provisioning it lazily.

        The first line creates the sandbox (or reattaches when a
        sandbox_id was given). Every line then reconciles the
        sandbox's mounts against the workspace's current mounts
        (sync_mounts, a no-op when nothing changed) and executes with
        the session environment merged over the sandbox environment
        and the cwd resolved under workspace_root.

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
                self._started = True
            await self.sync_mounts()
            self._build_translation()
        merged = {**self.env, **self._mount_env, **env}
        return await self.exec_line(self._translate_line(line), stdin, merged,
                                    self.sandbox_cwd(cwd))

    def _build_translation(self) -> None:
        """Map each virtual mount onto its physical sandbox mountpoint.

        Named mounts (``/s3``, ``/data``) rewrite cleanly; a bare ``/``
        world mount is skipped, as rebasing every absolute path would
        capture the sandbox's own ``/usr`` and ``/bin``.
        """
        root = self.workspace_root or "/workspace"
        mount_map: dict[str, str] = {}
        mount_env: dict[str, str] = {}
        if self._mount_prefixes is not None:
            for prefix in self._user_mount_prefixes():
                if prefix == "/":
                    continue
                mountpoint = posixpath.join(root, prefix.lstrip("/"))
                mount_map[prefix] = mountpoint
                var = "MIRAGE_" + re.sub(r"[^A-Z0-9]+", "_",
                                         prefix.strip("/").upper())
                mount_env[var] = mountpoint
        self._mount_map = mount_map
        self._mount_env = mount_env

    def _translate_line(self, line: str) -> str:
        """Rewrite virtual mount paths in a line to sandbox mountpoints.

        Only path tokens that begin exactly at a mount prefix (``/s3``
        or ``/s3/...``) are rewritten; siblings (``/s3.txt``), deeper
        system paths (``/usr/bin``), and relative paths are left alone.
        Longest prefix wins so nested mounts stay correct.

        Args:
            line (str): the raw line in the virtual namespace.
        """
        if not self._mount_map:
            return line
        for prefix in sorted(self._mount_map, key=len, reverse=True):
            # A mountpoint is a plain posix path: no backslashes or group
            # refs, so it is safe as a literal replacement string.
            target = self._mount_map[prefix].replace("\\", r"\\")
            pattern = rf"(?<![\w/.\-]){re.escape(prefix)}(?=/|\Z|[^\w.\-])"
            line = re.sub(pattern, target, line)
        return line

    def sandbox_cwd(self, cwd: str) -> str:
        """The session cwd as a path inside the sandbox.

        Args:
            cwd (str): the workspace-side working directory.
        """
        root = self.workspace_root or "/workspace"
        return posixpath.join(root, cwd.lstrip("/"))

    async def default_workspace_root(self) -> str:
        """The workspace_root when none was given, provider-resolved.

        Called once, after the sandbox is live and before the
        workspace mounts, so adapters can ask the sandbox itself
        (e.g. $HOME) for a directory its user can write.
        """
        return "/workspace"

    def _user_mount_prefixes(self) -> list[str]:
        assert self._mount_prefixes is not None
        prefixes = {p.rstrip("/") or "/" for p in self._mount_prefixes()}
        prefixes -= SYSTEM_MOUNTS
        # A bare "/" next to real mounts is the synthetic default root,
        # not a user mount; walk it only when it is the whole world.
        if len(prefixes) > 1:
            prefixes.discard("/")
        return sorted(prefixes)

    def _desired_mounts(self) -> dict[str, tuple[dict[str, Any], str]]:
        """The workspace's current mounts as (spec, sandbox mountpoint).

        Read fresh per reconcile, so mounts added to or removed from
        the workspace after the sandbox booted are picked up.
        """
        specs = self._mount_specs() if self._mount_specs is not None else {}
        root = self.workspace_root or "/workspace"
        desired: dict[str, tuple[dict[str, Any], str]] = {}
        for prefix in self._user_mount_prefixes():
            spec = specs.get(prefix)
            if spec is None:
                raise ValueError(
                    f"mount {prefix!r} is not remotely mountable; "
                    f"sandbox runtimes FUSE-mount remote-backed mounts")
            mountpoint = (root if prefix == "/" else posixpath.join(
                root, prefix.lstrip("/")))
            desired[prefix] = (spec, mountpoint)
        return desired

    async def sync_mounts(self) -> None:
        """Reconcile the sandbox's live mounts with the workspace's.

        The workspace is the desired state; the sandbox is the actual
        state. Each divergence becomes one in-sandbox mirage command,
        issued through the provider's own exec API: a new or changed
        mount runs ``mirage mount add <prefix> --fuse <path>`` (the
        spec travels in the exec environment, never as a file), a
        dropped mount runs ``mirage mount remove <prefix>``. Unchanged
        mounts cost nothing. Needs an image with mirage baked in
        (e.g. mirage-python-fuse). Subclasses may replace this
        wholesale (e.g. a provider volume).
        """
        if self._dispatch is None or self._mount_prefixes is None:
            return
        desired = self._desired_mounts()
        fingerprints = {
            prefix: json.dumps({
                **spec, "fuse": mountpoint
            }, sort_keys=True)
            for prefix, (spec, mountpoint) in desired.items()
        }
        for prefix in list(self._applied_mounts):
            if fingerprints.get(prefix) == self._applied_mounts[prefix]:
                continue
            await self._mount_command(
                f"mirage mount remove {shlex.quote(prefix)}", {})
            del self._applied_mounts[prefix]
        for prefix, (spec, mountpoint) in desired.items():
            if prefix in self._applied_mounts:
                continue
            await self._mount_command(
                f"mirage mount add {shlex.quote(prefix)} "
                f"--fuse {shlex.quote(mountpoint)}",
                {"MIRAGE_MOUNT_SPEC": json.dumps(spec)})
            self._applied_mounts[prefix] = fingerprints[prefix]

    async def _mount_command(self, command: str, env: dict[str, str]) -> None:
        """One in-sandbox mount reconcile command, failing loud.

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
