/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Maildir folder iterator
pub struct FolderIterator<'x> {
    inbox: Option<MessageIterator>,
    it_stack: Vec<fs::ReadDir>,
    name_stack: Vec<String>,
    prefix: Option<&'x str>,
}

/// Maildir message iterator
pub struct MessageIterator {
    name: Option<String>,
    cur_it: fs::ReadDir,
    new_it: fs::ReadDir,
}

/// Maildir message contents and metadata
#[derive(Debug, PartialEq, Eq, Clone, PartialOrd, Ord)]
pub struct Message {
    internal_date: u64,
    flags: Vec<Flag>,
    contents: Vec<u8>,
    path: PathBuf,
}

/// Flags of Maildir message
#[derive(Debug, PartialEq, Eq, Clone, Copy, PartialOrd, Ord)]
pub enum Flag {
    Passed,
    Replied,
    Seen,
    Trashed,
    Draft,
    Flagged,
}

impl FolderIterator<'_> {
    /// Creates a new Maildir folder iterator.
    /// For Maildir++ mailboxes use `Some(".")` as the prefix.
    /// For Dovecot Maildir mailboxes using LAYOUT=fs, use `None` as the prefix.
    pub fn new(
        path: impl Into<PathBuf>,
        sub_folder_prefix: Option<&str>,
    ) -> io::Result<FolderIterator<'_>> {
        let path = path.into();

        Ok(FolderIterator {
            it_stack: vec![fs::read_dir(&path)?],
            name_stack: Vec::new(),
            inbox: match MessageIterator::new_(&path, None) {
                Ok(inbox) => inbox.into(),
                Err(err) => {
                    if err.kind() == io::ErrorKind::NotFound {
                        None
                    } else {
                        return Err(err);
                    }
                }
            },
            prefix: sub_folder_prefix,
        })
    }
}

impl MessageIterator {
    /// Creates a new Maildir message iterator
    pub fn new(path: impl Into<PathBuf>) -> io::Result<MessageIterator> {
        MessageIterator::new_(&path.into(), None)
    }

    fn new_(path: &Path, name: Option<String>) -> io::Result<MessageIterator> {
        let mut cur_path = path.to_path_buf();
        cur_path.push("cur");
        if !cur_path.exists() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Invalid Maildir format, 'cur' directory not found.",
            ));
        }
        let mut new_path = path.to_path_buf();
        new_path.push("new");
        if !new_path.exists() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Invalid Maildir format, 'new' directory not found.",
            ));
        }

        Ok(MessageIterator {
            name,
            cur_it: fs::read_dir(cur_path)?,
            new_it: fs::read_dir(new_path)?,
        })
    }

    /// Returns the mailbox name of None for 'INBOX'.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }
}

impl Iterator for FolderIterator<'_> {
    type Item = io::Result<MessageIterator>;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(inbox) = self.inbox.take() {
            return Some(Ok(inbox));
        }

        loop {
            let entry = match self.it_stack.last_mut().unwrap().next() {
                Some(Ok(entry)) => entry,
                Some(Err(err)) => return Some(Err(err)),
                None => {
                    self.it_stack.pop();
                    self.name_stack.pop();

                    if !self.it_stack.is_empty() {
                        continue;
                    } else {
                        return None;
                    }
                }
            };

            let path = entry.path();
            if path.is_dir()
                && let Some(name) =
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .and_then(|name| {
                            if !["cur", "new", "tmp"].contains(&name) {
                                if let Some(prefix) = self.prefix {
                                    name.strip_prefix(prefix)
                                } else {
                                    name.into()
                                }
                            } else {
                                None
                            }
                        })
            {
                match fs::read_dir(&path) {
                    Ok(next_it) => {
                        self.it_stack.push(next_it);
                        self.name_stack.push(name.to_string());
                    }
                    Err(err) => {
                        return Some(Err(err));
                    }
                }

                match MessageIterator::new_(
                    &path,
                    self.name_stack.join(self.prefix.unwrap_or("/")).into(),
                ) {
                    Ok(folder) => return Some(Ok(folder)),
                    Err(err) => {
                        if err.kind() != io::ErrorKind::NotFound {
                            return Some(Err(err));
                        }
                    }
                }
            }
        }
    }
}

impl Iterator for MessageIterator {
    type Item = io::Result<Message>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let entry = match self.cur_it.next().or_else(|| self.new_it.next()) {
                Some(Ok(entry)) => entry,
                Some(Err(err)) => return Some(Err(err)),
                None => return None,
            };
            let path = entry.path();
            if path.is_file()
                && let Some(name) = path.file_name().and_then(|name| name.to_str())
                && !name.starts_with('.')
            {
                let internal_date =
                    match fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .and_then(|d| {
                            d.duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .map_err(|e| {
                                    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
                                })
                        }) {
                        Ok(metadata) => metadata,
                        Err(err) => return Some(Err(err)),
                    };
                let contents = match fs::read(&path) {
                    Ok(contents) => contents,
                    Err(err) => return Some(Err(err)),
                };
                let mut flags = Vec::new();
                if let Some((_, part)) = name.rsplit_once("2,") {
                    for &ch in part.as_bytes() {
                        match ch {
                            b'P' => flags.push(Flag::Passed),
                            b'R' => flags.push(Flag::Replied),
                            b'S' => flags.push(Flag::Seen),
                            b'T' => flags.push(Flag::Trashed),
                            b'D' => flags.push(Flag::Draft),
                            b'F' => flags.push(Flag::Flagged),
                            _ => {
                                if !ch.is_ascii_alphanumeric() {
                                    break;
                                }
                            }
                        }
                    }
                }
                return Some(Ok(Message {
                    contents,
                    internal_date,
                    flags,
                    path: path.to_path_buf(),
                }));
            }
        }
    }
}

impl Message {
    /// Returns the message creation date in seconds since UNIX epoch
    pub fn internal_date(&self) -> u64 {
        self.internal_date
    }

    /// Returns the message flags
    pub fn flags(&self) -> &[Flag] {
        &self.flags
    }

    /// Returns the path to the message file
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Returns the message contents
    pub fn contents(&self) -> &[u8] {
        &self.contents
    }

    /// Unwraps the message contents
    pub fn unwrap_contents(self) -> Vec<u8> {
        self.contents
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::mailbox::maildir::{Flag, Message};

    use super::FolderIterator;

    #[test]
    fn parse_maildir() {
        let mut messages = Vec::new();
        let expected_messages = vec![
            (
                "INBOX".to_string(),
                Message {
                    internal_date: 0,
                    flags: vec![Flag::Seen],
                    contents: vec![98, 10],
                    path: "unknown".into(),
                },
            ),
            (
                "INBOX".to_string(),
                Message {
                    internal_date: 0,
                    flags: vec![Flag::Seen, Flag::Trashed],
                    contents: vec![97, 10],
                    path: "unknown".into(),
                },
            ),
            (
                "My Folder".to_string(),
                Message {
                    internal_date: 0,
                    flags: vec![],
                    contents: vec![100, 10],
                    path: "unknown".into(),
                },
            ),
            (
                "My Folder".to_string(),
                Message {
                    internal_date: 0,
                    flags: vec![Flag::Trashed, Flag::Draft, Flag::Replied],
                    contents: vec![99, 10],
                    path: "unknown".into(),
                },
            ),
            (
                "My Folder.Nested Folder".to_string(),
                Message {
                    internal_date: 0,
                    flags: vec![Flag::Replied, Flag::Draft, Flag::Flagged],
                    contents: vec![102, 10],
                    path: "unknown".into(),
                },
            ),
            (
                "My Folder.Nested Folder".to_string(),
                Message {
                    internal_date: 0,
                    flags: vec![Flag::Flagged, Flag::Passed],
                    contents: vec![101, 10],
                    path: "unknown".into(),
                },
            ),
        ];

        for folder in FolderIterator::new(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("maildir"),
            ".".into(),
        )
        .unwrap()
        {
            let folder = folder.unwrap();
            let name = folder.name().unwrap_or("INBOX").to_string();

            for message in folder {
                let mut message = message.unwrap();
                assert_ne!(message.internal_date(), 0);
                assert!(message.path.exists());
                message.internal_date = 0;
                message.path = PathBuf::from("unknown");
                messages.push((name.clone(), message));
            }
        }

        messages.sort_unstable();
        assert_eq!(messages, expected_messages);
    }
}
