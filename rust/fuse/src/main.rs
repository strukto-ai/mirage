#[cfg(target_os = "linux")]
mod fs;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod link;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod proto;

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [flag] if flag == "--version" => {
            println!("{}", version());
            ExitCode::SUCCESS
        }
        [command, source, mountpoint] if command == "serve" => serve(source, mountpoint),
        _ => {
            eprintln!("usage: mirage-fuse serve <source> <mountpoint> | mirage-fuse --version");
            ExitCode::from(2)
        }
    }
}

/// Mount `source`'s prefix at `mountpoint` and answer the kernel from what
/// the host serves on stdin and stdout, until the host closes the pipe.
#[cfg(target_os = "linux")]
fn serve(source: &str, mountpoint: &str) -> ExitCode {
    use fs::{MirageFs, Note, Shared};
    use fuser::{Config, INodeNo, MountOption, Session};
    use serde_json::{Map, json};
    use std::ffi::OsStr;
    use std::io;
    use std::sync::Arc;
    use std::sync::mpsc::channel;

    let Some((_, root)) = source.split_once(':') else {
        eprintln!("mirage-fuse: {source} names no prefix");
        return ExitCode::from(2);
    };
    let link = Arc::new(link::Link::new(Box::new(io::stdout())));
    let (notes, pending) = channel::<Note>();
    let shared = Arc::new(Shared::new(root.to_string(), notes));
    let reader = {
        let (link, shared) = (link.clone(), shared.clone());
        std::thread::spawn(move || {
            if let Err(err) = link.serve(&mut io::stdin().lock(), |frame| shared.push(frame)) {
                eprintln!("mirage-fuse: reading the host failed: {err}");
            }
        })
    };
    match link.call("hello", json!({ "proto": proto::PROTOCOL }), &[]) {
        Ok(frame) if frame.u64("proto") == Some(proto::PROTOCOL) => {}
        Ok(frame) => {
            eprintln!(
                "mirage-fuse: the host speaks fsproto {:?}, this client {}",
                frame.u64("proto"),
                proto::PROTOCOL
            );
            return ExitCode::from(1);
        }
        Err(err) => {
            eprintln!("mirage-fuse: the host did not answer: {err:?}");
            return ExitCode::from(1);
        }
    }
    let mut config = Config::default();
    config.mount_options = vec![
        MountOption::FSName(source.to_string()),
        MountOption::Subtype("mirage".into()),
        MountOption::NoDev,
        MountOption::NoSuid,
    ];
    config.n_threads = Some(8);
    let fs = MirageFs::new(link.clone(), shared);
    let (mounted, direct) = match mount_direct(source, mountpoint) {
        Ok(Some(fd)) => (Session::from_fd(fs, fd, config.acl, config), true),
        Ok(None) => (Session::new(fs, mountpoint, &config), false),
        Err(err) => (Err(err), false),
    };
    let failed = |doing: &str, err: io::Error| {
        eprintln!("mirage-fuse: {doing} {mountpoint} failed: {err}");
        if direct {
            unmount(mountpoint);
        }
        ExitCode::from(1)
    };
    let session = match mounted {
        Ok(session) => session,
        Err(err) => return failed("mounting", err),
    };
    let background = match session.spawn() {
        Ok(background) => background,
        Err(err) => return failed("serving", err),
    };
    let notifier = background.notifier();
    std::thread::spawn(move || {
        for note in pending {
            match note {
                Note::Entry(parent, name) => {
                    let _ = notifier.inval_entry(INodeNo(parent), OsStr::new(&name));
                }
                Note::Inode(ino) => {
                    let _ = notifier.inval_inode(INodeNo(ino), 0, 0);
                }
                Note::Ack(hid) => {
                    let mut head = Map::new();
                    head.insert("hid".into(), hid.into());
                    if let Err(err) = link.send(&head, &[]) {
                        eprintln!("mirage-fuse: answering a barrier failed: {err}");
                    }
                }
            }
        }
    });
    let _ = reader.join();
    unmount(mountpoint);
    std::process::exit(0)
}

/// Mount `/dev/fuse` at `mountpoint` as `fuse.mirage` when this process
/// may call mount(2) itself, as root does: fuser's own direct mount names
/// the type plain `fuse`, and the host finds its mount by the type. None
/// when mount(2) is refused, for fuser to mount through fusermount3, which
/// names the subtype.
#[cfg(target_os = "linux")]
fn mount_direct(source: &str, mountpoint: &str) -> std::io::Result<Option<std::os::fd::OwnedFd>> {
    use std::ffi::CString;
    use std::io::{Error, ErrorKind};
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::os::unix::fs::MetadataExt;

    let bad = |_| Error::from(ErrorKind::InvalidInput);
    let device = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/fuse")?;
    let rootmode = std::fs::metadata(mountpoint)?.mode() & libc::S_IFMT;
    let data = format!(
        "fd={},rootmode={:o},user_id={},group_id={}",
        device.as_raw_fd(),
        rootmode,
        unsafe { libc::getuid() },
        unsafe { libc::getgid() }
    );
    let (source, target) = (
        CString::new(source).map_err(bad)?,
        CString::new(mountpoint).map_err(bad)?,
    );
    let (kind, data) = (
        CString::new("fuse.mirage").map_err(bad)?,
        CString::new(data).map_err(bad)?,
    );
    let done = unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            kind.as_ptr(),
            libc::MS_NOSUID | libc::MS_NODEV,
            data.as_ptr().cast(),
        )
    };
    if done == 0 {
        return Ok(Some(OwnedFd::from(device)));
    }
    let error = Error::last_os_error();
    if error.raw_os_error() == Some(libc::EPERM) {
        return Ok(None);
    }
    Err(error)
}

/// Detach the mount, through fusermount when this process may not
/// unmount itself; a mountpoint no longer mounted is left alone.
#[cfg(target_os = "linux")]
fn unmount(mountpoint: &str) {
    let Ok(target) = std::ffi::CString::new(mountpoint) else {
        return;
    };
    if unsafe { libc::umount2(target.as_ptr(), libc::MNT_DETACH) } == 0
        || std::io::Error::last_os_error().raw_os_error() != Some(libc::EPERM)
    {
        return;
    }
    for helper in ["fusermount3", "fusermount"] {
        let done = std::process::Command::new(helper)
            .args(["-uz", mountpoint])
            .status();
        if done.is_ok_and(|status| status.success()) {
            break;
        }
    }
}

/// The protocol is named only where the binary can serve it, so a host's
/// install check on a machine without Linux FUSE refuses it.
#[cfg(target_os = "linux")]
fn version() -> String {
    format!(
        "mirage-fuse {} fsproto {}",
        env!("CARGO_PKG_VERSION"),
        proto::PROTOCOL
    )
}

#[cfg(not(target_os = "linux"))]
fn version() -> String {
    format!(
        "mirage-fuse {} (serving needs Linux)",
        env!("CARGO_PKG_VERSION")
    )
}

#[cfg(not(target_os = "linux"))]
fn serve(_source: &str, _mountpoint: &str) -> ExitCode {
    eprintln!("mirage-fuse: serving needs Linux");
    ExitCode::from(1)
}
