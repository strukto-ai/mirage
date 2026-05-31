# SSH Resource Examples

Mount a remote host over SFTP and read it as a filesystem — either via the in-process VFS patch or a real macFUSE/libfuse mount.

## Setup

Set the following in `.env.development` at the repo root:

```bash
SSH_HOST=example.com           # required: SFTP host
SSH_USER=ubuntu                # required: username
SSH_KEY=~/.ssh/id_ed25519      # optional: private key path
SSH_PASSWORD=...               # optional: fallback if no key
SSH_PORT=22                    # optional, default 22
SSH_ROOT=/                     # optional, default /
SSH_PASSPHRASE=...             # optional: for encrypted keys
```

## Run VFS demo

In-process `fs.*` patch — no kernel mount, no daemon. Reads `/etc/hostname` over SFTP and exits.

```bash
pnpm exec tsx examples/typescript/ssh/ssh_vfs.ts
```

## Run FUSE demo

Real OS mount via `FuseManager`. After mount, the script prints the mount path and waits for Enter to unmount.

```bash
pnpm exec tsx examples/typescript/ssh/ssh_fuse.ts
```

While running, open a second terminal (or Finder) and explore the remote filesystem:

```bash
open <mp>/ssh                  # macOS Finder
ls <mp>/ssh/
cat <mp>/ssh/etc/hostname
```

## Production note

The SSH connection holds credentials (key material or password) in-process. For shared servers, restrict the SSH user with a per-user `chroot`/`AllowUsers` directive in `sshd_config` so the mount only sees what that user is meant to see. A browser build is impossible — SSH/SFTP is a TCP protocol with no CORS-equivalent and no transport that survives in a browser sandbox; see [`docs/plans/2026-04-29-ssh-resource.md`](../../../docs/plans/2026-04-29-ssh-resource.md) for the full design.
