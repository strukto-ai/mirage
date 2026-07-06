// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import ssh2, { type Server, type SFTPWrapper } from "ssh2";
import { MountMode, SSHResource, Workspace } from "@struktoai/mirage-node";
import { assertRealMtime, runCases } from "./cases.ts";

const { STATUS_CODE, flagsToString } = ssh2.utils.sftp;

interface OpenFile {
  fd: number;
}

interface OpenDir {
  entries: fs.Dirent[];
  path: string;
  done: boolean;
}

function statusFor(err: unknown): number {
  const code = (err as { code?: string }).code;
  if (code === "ENOENT") return STATUS_CODE.NO_SUCH_FILE;
  if (code === "EACCES" || code === "EPERM") return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function attrsOf(st: fs.Stats): {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
} {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function longnameOf(name: string, st: fs.Stats): string {
  const kind = st.isDirectory() ? "d" : "-";
  return `${kind}rw-r--r--   1 integ integ ${st.size} Jan  1 00:00 ${name}`;
}

function makeMockSftp(root: string) {
  const handles = new Map<number, OpenFile | OpenDir>();
  let nextHandle = 1;

  const resolvePath = (p: string): string => {
    const virtual = posix.normalize("/" + p.replace(/^\/+/, ""));
    return join(root, "." + virtual);
  };

  const allocHandle = (value: OpenFile | OpenDir): Buffer => {
    const id = nextHandle;
    nextHandle += 1;
    handles.set(id, value);
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(id, 0);
    return buf;
  };

  const getHandle = (buf: Buffer): OpenFile | OpenDir | undefined =>
    buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : undefined;

  return (sftp: SFTPWrapper): void => {
    const s = sftp as unknown as {
      on(event: string, cb: (...args: never[]) => void): void;
      handle(reqid: number, handle: Buffer): void;
      status(reqid: number, code: number): void;
      attrs(reqid: number, attrs: ReturnType<typeof attrsOf>): void;
      data(reqid: number, data: Buffer): void;
      name(
        reqid: number,
        names: { filename: string; longname: string; attrs?: ReturnType<typeof attrsOf> }[],
      ): void;
    };

    s.on("OPEN", (reqid: number, filename: string, flags: number) => {
      try {
        const fsFlags = flagsToString(flags) ?? "r";
        const fd = fs.openSync(resolvePath(filename), fsFlags);
        s.handle(reqid, allocHandle({ fd }));
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("READ", (reqid: number, handle: Buffer, offset: number, length: number) => {
      const h = getHandle(handle);
      if (h === undefined || !("fd" in h)) {
        s.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      try {
        const buf = Buffer.alloc(length);
        const n = fs.readSync(h.fd, buf, 0, length, offset);
        if (n === 0) s.status(reqid, STATUS_CODE.EOF);
        else s.data(reqid, buf.subarray(0, n));
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("WRITE", (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
      const h = getHandle(handle);
      if (h === undefined || !("fd" in h)) {
        s.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      try {
        fs.writeSync(h.fd, data, 0, data.length, offset);
        s.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("FSTAT", (reqid: number, handle: Buffer) => {
      const h = getHandle(handle);
      if (h === undefined || !("fd" in h)) {
        s.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      try {
        s.attrs(reqid, attrsOf(fs.fstatSync(h.fd)));
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("FSETSTAT", (reqid: number) => {
      s.status(reqid, STATUS_CODE.OK);
    });

    s.on("SETSTAT", (reqid: number) => {
      s.status(reqid, STATUS_CODE.OK);
    });

    s.on("CLOSE", (reqid: number, handle: Buffer) => {
      const h = getHandle(handle);
      if (h === undefined) {
        s.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      if ("fd" in h) fs.closeSync(h.fd);
      handles.delete(handle.readUInt32BE(0));
      s.status(reqid, STATUS_CODE.OK);
    });

    s.on("OPENDIR", (reqid: number, path: string) => {
      try {
        const real = resolvePath(path);
        if (!fs.statSync(real).isDirectory()) {
          s.status(reqid, STATUS_CODE.FAILURE);
          return;
        }
        const entries = fs.readdirSync(real, { withFileTypes: true });
        s.handle(reqid, allocHandle({ entries, path: real, done: false }));
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("READDIR", (reqid: number, handle: Buffer) => {
      const h = getHandle(handle);
      if (h === undefined || !("entries" in h)) {
        s.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      if (h.done) {
        s.status(reqid, STATUS_CODE.EOF);
        return;
      }
      h.done = true;
      const names = [];
      for (const entry of h.entries) {
        const st = fs.lstatSync(join(h.path, entry.name));
        names.push({
          filename: entry.name,
          longname: longnameOf(entry.name, st),
          attrs: attrsOf(st),
        });
      }
      s.name(reqid, names);
    });

    s.on("LSTAT", (reqid: number, path: string) => {
      try {
        s.attrs(reqid, attrsOf(fs.lstatSync(resolvePath(path))));
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("STAT", (reqid: number, path: string) => {
      try {
        s.attrs(reqid, attrsOf(fs.statSync(resolvePath(path))));
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("REMOVE", (reqid: number, path: string) => {
      try {
        fs.unlinkSync(resolvePath(path));
        s.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("RMDIR", (reqid: number, path: string) => {
      try {
        fs.rmdirSync(resolvePath(path));
        s.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("MKDIR", (reqid: number, path: string) => {
      try {
        fs.mkdirSync(resolvePath(path));
        s.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("RENAME", (reqid: number, oldPath: string, newPath: string) => {
      try {
        fs.renameSync(resolvePath(oldPath), resolvePath(newPath));
        s.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        s.status(reqid, statusFor(err));
      }
    });

    s.on("REALPATH", (reqid: number, path: string) => {
      const virtual = posix.normalize("/" + path.replace(/^\/+/, ""));
      s.name(reqid, [{ filename: virtual, longname: virtual }]);
    });
  };
}

function startMockServer(root: string): Promise<{ server: Server; port: number }> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const hostKey = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const handleSftp = makeMockSftp(root);
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("sftp", (acceptSftp) => {
          handleSftp(acceptSftp());
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      resolve({ server, port: address.port });
    });
  });
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(join(tmpdir(), "mirage-integ-ssh-"));
  const { server, port } = await startMockServer(root);
  // Sibling subroots: /data must not see /data2's directory in its
  // own listings, so neither mount roots at the chroot root.
  fs.mkdirSync(join(root, "xm1"), { recursive: true });
  fs.mkdirSync(join(root, "xm2"), { recursive: true });
  const resource = new SSHResource({
    host: "127.0.0.1",
    port,
    username: "integ",
    password: "integ",
    root: "/xm1",
  });
  const resource2 = new SSHResource({
    host: "127.0.0.1",
    port,
    username: "integ",
    password: "integ",
    root: "/xm2",
  });
  const ws = new Workspace(
    { "/data": resource, "/data2": resource2 },
    { mode: MountMode.WRITE },
  );
  try {
    await runCases(ws);
    await assertRealMtime(ws);
  } finally {
    await ws.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
