# Mirage terminal backend for Hermes Agent

Runs Hermes' terminal and file tools in a [Mirage](https://github.com/strukto-ai/mirage) workspace. Every command the `terminal` tool runs, and every `read_file`, `write_file`, `patch` and `search_files`, goes to the workspace instead of your computer.

A Mirage workspace mounts services as folders, such as S3, GitHub, Slack, Linear or a local directory, under one bash-compatible shell. Mirage runs `cat`, `grep`, pipes and redirects itself, and runs other programs (`python3`, `git`, `node`) on a machine you add to the workspace, such as a Docker container or an E2B sandbox.

## Setup

1. Install and enable the plugin. Hermes installs `mirage-ai` into its own environment.

   ```bash
   hermes plugins install strukto-ai/mirage/plugins/hermes --enable
   ```

1. Put every key the workspace needs in your Hermes profile:

   ```bash
   hermes config set GITHUB_TOKEN ghp_...
   ```

1. Write the workspace YAML, naming each key as `${NAME}`:

   ```yaml
   processes: workspace
   mounts:
     /tmp: { vfs: ram, mode: write }
     /project: { vfs: disk, mode: write, config: { root: /Users/me/project } }
     /github:
       vfs: github
       mode: read
       config: { token: "${GITHUB_TOKEN}", owner: strukto-ai, repo: mirage }
   ```

   Hermes keeps its shell state and background-job logs in `/tmp`, and polls a background job from another session than the one that started it, so the backend needs both `/tmp` and `processes: workspace`.

1. Point Hermes at it:

   ```bash
   hermes config set terminal.backend mirage
   hermes config set plugins.entries.mirage.settings.config /Users/me/workspace.yaml
   ```

## Keys

The plugin reads keys only from Hermes, with `get_secret`, so each Hermes profile uses its own keys. Workspaces are kept apart by YAML path and key values: two profiles with different keys never share one, while profiles with the same keys, or a YAML that names none, share one. `${NAME}` anywhere in the YAML, `{from: env, key: NAME}` in a mount, CLI or machine config, and an `env:` entry with `from: env` all read `NAME` from the active profile.

The plugin refuses a workspace YAML that would reach a key any other way, and the error names each place:

- a `secrets:` block, or a key from `dotenv`, `1password` or `aws-sm`, in any `env:` block, including a session profile's;
- a key pointer in a policy program's `env` (write `${NAME}` there instead);
- a backend, CLI or runtime named by a `module:Class` reference, or one outside Mirage's own list;
- an S3 or S3-compatible mount, or an S3 `store:` group, without an access key pair, or with `aws_profile`, which would read `~/.aws`;
- an `ssh` mount or machine, which reads `~/.ssh/config` and the ssh-agent;
- a `kubernetes` machine, which reads `~/.kube/config`;
- an `e2b`, `daytona` or `boxd` machine without `api_key`;
- a `postgres` dsn without a password, which reads `PGPASSWORD` or `~/.pgpass`;
- a `chroma` mount, which reads `CHROMA_*` variables and `./.env`;
- a `mongodb` or `gridfs` uri using `MONGODB-AWS` without a key, which reads `~/.aws`;
- a `lancedb` `db://` uri without `api_key`, or any other cloud uri unless it is `s3://` with a key pair in `storage_options`.

### OAuth

Mirage refreshes OAuth tokens itself, and a Hermes plugin may not, so a mount with a `refresh_token` or `client_secret` is refused: Google (`gdrive`, `gmail`, `gcal`, `gdocs`, `gsheets`, `gslides` and the `gws` CLI), Box and Dropbox. A Google or Box mount works with a short-lived `access_token` until it expires; Dropbox, which takes only a refresh token, is not available.

## What it does on your system

- **Network:** Mirage calls each service the workspace YAML mounts, with the key you gave it for that service. The plugin adds no telemetry.
- **Keys:** read from the active Hermes profile when a Hermes task starts, and held in memory for the workspace's life. The plugin writes no key anywhere.
- **Local files:** a `disk` mount reads and writes the folder its `root` names.
- **Commands:** commands run inside the workspace. A program Mirage does not run itself runs on a machine the YAML adds. A `docker`, `apple_container`, `smolvm` or `microsandbox` machine runs that tool's CLI on your computer, with your environment and that tool's own configuration (for Docker, `DOCKER_HOST` and its contexts). A `host` machine runs programs directly on your computer, where they reach whatever your user account can, unless a `sandbox` block confines them (Linux only).
- **Background work:** each Hermes task gets its own sessions in the workspace for its YAML and keys, and a background job lives until its task ends. The workspaces close when Hermes exits. A YAML with a FUSE mount serves one set of keys: a second profile needs its own YAML.
- **Approvals:** Hermes' `approvals.mode` still decides which commands ask first, and the workspace's command rules apply as well.

Full guide: [docs.mirage.strukto.ai/home/agents/hermes](https://docs.mirage.strukto.ai/home/agents/hermes)
