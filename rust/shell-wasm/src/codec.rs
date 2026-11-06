//! The layout the session engine's requests and replies take across the
//! module boundary: one item, a tag byte then its body, little-endian.
//! 0 none, 1 false, 2 true, 3 a number (`i64`, which the host reads as a
//! float), 4 text (a `u32` length and the bytes, which the host reads as
//! shell text), 5 a list (a `u32` count and the items), 6 a map (a `u32`
//! count and each key then value), 7 a big integer (`i64`, which the host
//! reads exactly), 8 raw bytes (as text, which the host keeps as bytes).

pub enum Item {
    Nil,
    Bool(bool),
    Int(i64),
    Text(Vec<u8>),
    List(Vec<Item>),
    Map(Vec<(Item, Item)>),
    Big(i64),
    Raw(Vec<u8>),
}

impl Item {
    pub fn text(bytes: impl AsRef<[u8]>) -> Self {
        Item::Text(bytes.as_ref().to_vec())
    }

    pub fn int(value: impl TryInto<i64>) -> Self {
        Item::Int(value.try_into().unwrap_or(i64::MAX))
    }

    pub fn list(items: impl IntoIterator<Item = Item>) -> Self {
        Item::List(items.into_iter().collect())
    }

    pub fn opt<T>(value: Option<T>, f: impl FnOnce(T) -> Item) -> Self {
        value.map_or(Item::Nil, f)
    }

    pub fn encode(&self, out: &mut Vec<u8>) {
        let len = |out: &mut Vec<u8>, n: usize| {
            out.extend_from_slice(&u32::try_from(n).unwrap_or(u32::MAX).to_le_bytes());
        };
        match self {
            Item::Nil => out.push(0),
            Item::Bool(false) => out.push(1),
            Item::Bool(true) => out.push(2),
            Item::Int(value) => {
                out.push(3);
                out.extend_from_slice(&value.to_le_bytes());
            }
            Item::Text(bytes) | Item::Raw(bytes) => {
                out.push(if matches!(self, Item::Text(_)) { 4 } else { 8 });
                len(out, bytes.len());
                out.extend_from_slice(bytes);
            }
            Item::List(items) => {
                out.push(5);
                len(out, items.len());
                for item in items {
                    item.encode(out);
                }
            }
            Item::Map(pairs) => {
                out.push(6);
                len(out, pairs.len());
                for (key, value) in pairs {
                    key.encode(out);
                    value.encode(out);
                }
            }
            Item::Big(value) => {
                out.push(7);
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
    }

    /// Read one item from the front of `bytes`, None for a malformed one.
    pub fn decode(bytes: &mut &[u8]) -> Option<Item> {
        let (&tag, rest) = bytes.split_first()?;
        *bytes = rest;
        let word = |bytes: &mut &[u8]| -> Option<u32> {
            let (head, rest) = bytes.split_at_checked(4)?;
            *bytes = rest;
            Some(u32::from_le_bytes(head.try_into().ok()?))
        };
        let wide = |bytes: &mut &[u8]| -> Option<i64> {
            let (head, rest) = bytes.split_at_checked(8)?;
            *bytes = rest;
            Some(i64::from_le_bytes(head.try_into().ok()?))
        };
        Some(match tag {
            0 => Item::Nil,
            1 => Item::Bool(false),
            2 => Item::Bool(true),
            3 => Item::Int(wide(bytes)?),
            4 | 8 => {
                let n = word(bytes)? as usize;
                let (head, rest) = bytes.split_at_checked(n)?;
                *bytes = rest;
                if tag == 4 {
                    Item::Text(head.to_vec())
                } else {
                    Item::Raw(head.to_vec())
                }
            }
            5 => {
                let n = word(bytes)?;
                let mut items = Vec::new();
                for _ in 0..n {
                    items.push(Item::decode(bytes)?);
                }
                Item::List(items)
            }
            6 => {
                let n = word(bytes)?;
                let mut pairs = Vec::new();
                for _ in 0..n {
                    let key = Item::decode(bytes)?;
                    pairs.push((key, Item::decode(bytes)?));
                }
                Item::Map(pairs)
            }
            7 => Item::Big(wide(bytes)?),
            _ => return None,
        })
    }
}

/// A request's arguments, read in order.
pub struct Args(std::vec::IntoIter<Item>);

impl Args {
    pub fn new(items: Vec<Item>) -> Self {
        Self(items.into_iter())
    }

    pub fn item(&mut self) -> Result<Item, String> {
        self.0.next().ok_or_else(|| "a request is short".to_owned())
    }

    pub fn bytes(&mut self) -> Result<Vec<u8>, String> {
        match self.item()? {
            Item::Text(bytes) | Item::Raw(bytes) => Ok(bytes),
            _ => Err("a request expected text".to_owned()),
        }
    }

    pub fn string(&mut self) -> Result<String, String> {
        String::from_utf8(self.bytes()?).map_err(|_| "a name is not UTF-8".to_owned())
    }

    pub fn int(&mut self) -> Result<i64, String> {
        match self.item()? {
            Item::Int(value) | Item::Big(value) => Ok(value),
            _ => Err("a request expected a number".to_owned()),
        }
    }

    pub fn flag(&mut self) -> Result<bool, String> {
        match self.item()? {
            Item::Bool(value) => Ok(value),
            _ => Err("a request expected a flag".to_owned()),
        }
    }

    pub fn handle(&mut self) -> Result<u32, String> {
        u32::try_from(self.int()?).map_err(|_| "a handle is out of range".to_owned())
    }

    pub fn list(&mut self) -> Result<Vec<Item>, String> {
        match self.item()? {
            Item::List(items) => Ok(items),
            _ => Err("a request expected a list".to_owned()),
        }
    }

    /// The next item, None when it is `Nil`.
    pub fn maybe(&mut self) -> Result<Option<Item>, String> {
        Ok(match self.item()? {
            Item::Nil => None,
            item => Some(item),
        })
    }
}

/// Read `item` as one argument, through `read`.
pub fn one<T>(item: Item, read: impl FnOnce(&mut Args) -> Result<T, String>) -> Result<T, String> {
    read(&mut Args::new(vec![item]))
}
