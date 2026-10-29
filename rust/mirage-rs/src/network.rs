use std::net::IpAddr;

use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

// Where clouds serve a machine its credentials: the IPv4 and IPv6
// link-local ranges, and AWS's IPv6 metadata address.
const METADATA: [&str; 3] = ["169.254.0.0/16", "fe80::/10", "fd00:ec2::254"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    layers: Vec<LayerConfig>,
    #[serde(default)]
    metadata: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LayerConfig {
    #[serde(default)]
    allow: Option<Vec<String>>,
    #[serde(default)]
    deny: Vec<String>,
}

enum Entry {
    Range(IpAddr, u8),
    Host(String),
    Suffix(String),
}

struct Layer {
    allow: Option<Vec<Entry>>,
    deny: Vec<Entry>,
}

struct Network {
    layers: Vec<Layer>,
}

/// Whether a workspace may open one connection. A rule is a list of layers,
/// the workspace's own `network` setting and an operator's ceiling among
/// them, and a connection opens only when every layer lets it: a layer with
/// an allow list lets what an entry names, and none lets what its deny list
/// names. The hosts ask once per connection with the host name and the
/// address it resolved to, `host\0address`, either part empty when not known.
pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let mut layers = config
        .layers
        .iter()
        .map(|layer| {
            Ok(Layer {
                allow: layer
                    .allow
                    .as_ref()
                    .map(|entries| entries.iter().map(|text| entry(text)).collect())
                    .transpose()?,
                deny: layer
                    .deny
                    .iter()
                    .map(|text| entry(text))
                    .collect::<Result<_, _>>()?,
            })
        })
        .collect::<Result<Vec<_>, StreamError>>()?;
    if config.metadata {
        layers.push(Layer {
            allow: None,
            deny: METADATA
                .iter()
                .map(|text| entry(text))
                .collect::<Result<_, _>>()?,
        });
    }
    Ok(Box::new(Network { layers }))
}

/// One allow or deny entry: an address, a range in CIDR form, a host name,
/// or `*.` and a name for every host under it.
fn entry(text: &str) -> Result<Entry, StreamError> {
    let bad = || {
        StreamError::new(format!(
            "network: {text} is not an address, a range or a host name"
        ))
    };
    let (head, prefix) = match text.split_once('/') {
        Some((head, prefix)) => (head, Some(prefix)),
        None => (text, None),
    };
    if let Ok(address) = head.parse::<IpAddr>() {
        let width: u8 = if address.is_ipv4() { 32 } else { 128 };
        let bits = match prefix {
            None => width,
            Some(prefix) => prefix
                .parse::<u8>()
                .ok()
                .filter(|bits| *bits <= width)
                .ok_or_else(bad)?,
        };
        return Ok(match address {
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) if bits >= 96 => Entry::Range(IpAddr::V4(v4), bits - 96),
                _ => Entry::Range(address, bits),
            },
            IpAddr::V4(_) => Entry::Range(address, bits),
        });
    }
    if prefix.is_some() {
        return Err(bad());
    }
    let name = text.trim_end_matches('.').to_ascii_lowercase();
    let (wildcard, name) = match name.strip_prefix("*.") {
        Some(rest) => (true, rest.to_string()),
        None => (false, name),
    };
    if name.is_empty() || !name.split('.').all(label) {
        return Err(bad());
    }
    Ok(if wildcard {
        Entry::Suffix(name)
    } else {
        Entry::Host(name)
    })
}

fn label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// An address as a host reports it: bracketed or not, with a zone or not,
/// and an IPv4 address written as IPv6 (`::ffff:a.b.c.d`) read as itself.
fn address(text: &str) -> Option<IpAddr> {
    let text = text
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(text);
    let text = text.split_once('%').map_or(text, |(head, _)| head);
    match text.parse::<IpAddr>().ok()? {
        IpAddr::V6(v6) => Some(v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4)),
        v4 => Some(v4),
    }
}

fn within(range: IpAddr, bits: u8, address: IpAddr) -> bool {
    let (range, address, width) = match (range, address) {
        (IpAddr::V4(range), IpAddr::V4(address)) => (
            u128::from(u32::from(range)),
            u128::from(u32::from(address)),
            32,
        ),
        (IpAddr::V6(range), IpAddr::V6(address)) => (u128::from(range), u128::from(address), 128),
        _ => return false,
    };
    bits == 0 || range >> (width - u32::from(bits)) == address >> (width - u32::from(bits))
}

impl Entry {
    fn names(&self, host: &str, address: Option<IpAddr>) -> bool {
        match self {
            Self::Range(range, bits) => {
                address.is_some_and(|address| within(*range, *bits, address))
            }
            Self::Host(name) => host == name,
            Self::Suffix(name) => host
                .strip_suffix(name.as_str())
                .is_some_and(|head| head.ends_with('.') && head.len() > 1),
        }
    }
}

impl Layer {
    fn lets(&self, host: &str, address: Option<IpAddr>) -> bool {
        self.allow
            .as_ref()
            .is_none_or(|allow| allow.iter().any(|entry| entry.names(host, address)))
            && !self.deny.iter().any(|entry| entry.names(host, address))
    }
}

impl Stream for Network {
    fn feed(&mut self, _: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("network answers test only"))
    }

    fn finish(&mut self, _: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("network answers test only"))
    }

    fn test(&mut self, input: &[u8]) -> Result<bool, StreamError> {
        let text = std::str::from_utf8(input)
            .map_err(|_| StreamError::new("network: the subject is not UTF-8"))?;
        let (host, given) = text.split_once('\0').unwrap_or((text, ""));
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        let found =
            if given.is_empty() {
                address(&host)
            } else {
                Some(address(given).ok_or_else(|| {
                    StreamError::new(format!("network: {given} is not an address"))
                })?)
            };
        let host = if found.is_some() && address(&host).is_some() {
            String::new()
        } else {
            host
        };
        Ok(self.layers.iter().all(|layer| layer.lets(&host, found)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(config: &str) -> Box<dyn Stream> {
        open(config.as_bytes()).expect("rule opens")
    }

    fn lets(rule: &mut Box<dyn Stream>, host: &str, address: &str) -> bool {
        rule.test(format!("{host}\0{address}").as_bytes())
            .expect("answers")
    }

    #[test]
    fn no_layer_lets_every_connection() {
        let mut open_rule = rule(r#"{"layers": []}"#);
        assert!(lets(&mut open_rule, "example.com", "93.184.216.34"));
        assert!(lets(&mut open_rule, "", "127.0.0.1"));
    }

    #[test]
    fn an_empty_allow_list_is_the_network_off() {
        let mut off = rule(r#"{"layers": [{"allow": []}]}"#);
        assert!(!lets(&mut off, "example.com", "93.184.216.34"));
        assert!(!lets(&mut off, "", "127.0.0.1"));
    }

    #[test]
    fn an_allow_list_names_hosts_suffixes_and_ranges() {
        let mut allow = rule(
            r#"{"layers": [{"allow": ["API.GitHub.com.", "*.slack.com", "10.0.0.0/8", "::1"]}]}"#,
        );
        assert!(lets(&mut allow, "api.github.com", "140.82.112.6"));
        assert!(lets(&mut allow, "API.GITHUB.COM.", ""));
        assert!(!lets(&mut allow, "github.com", "140.82.112.4"));
        assert!(lets(&mut allow, "files.slack.com", "1.2.3.4"));
        assert!(lets(&mut allow, "a.b.slack.com", ""));
        assert!(!lets(&mut allow, "slack.com", ""));
        assert!(!lets(&mut allow, "notslack.com", ""));
        assert!(lets(&mut allow, "", "10.20.30.40"));
        assert!(lets(&mut allow, "db.internal", "10.0.0.5"));
        assert!(!lets(&mut allow, "", "11.0.0.1"));
        assert!(lets(&mut allow, "", "[::1]"));
        assert!(lets(&mut allow, "::1", ""));
    }

    #[test]
    fn an_ipv4_address_written_as_ipv6_is_itself() {
        let mut allow = rule(r#"{"layers": [{"allow": ["10.0.0.0/8"]}]}"#);
        assert!(lets(&mut allow, "", "::ffff:10.1.2.3"));
        let mut mapped = rule(r#"{"layers": [{"allow": ["::ffff:10.0.0.0/104"]}]}"#);
        assert!(lets(&mut mapped, "", "10.9.9.9"));
        assert!(!lets(&mut mapped, "", "11.9.9.9"));
    }

    #[test]
    fn every_layer_must_let_a_connection() {
        let mut both =
            rule(r#"{"layers": [{"allow": ["*.example.com"]}, {"deny": ["10.0.0.0/8"]}]}"#);
        assert!(lets(&mut both, "api.example.com", "93.184.216.34"));
        assert!(!lets(&mut both, "api.example.com", "10.0.0.5"));
        assert!(!lets(&mut both, "api.other.com", "93.184.216.34"));
    }

    #[test]
    fn the_metadata_block_refuses_link_local_addresses() {
        let mut guarded = rule(r#"{"layers": [], "metadata": true}"#);
        assert!(!lets(&mut guarded, "", "169.254.169.254"));
        assert!(!lets(&mut guarded, "evil.example.com", "169.254.170.2"));
        assert!(!lets(&mut guarded, "", "::ffff:169.254.169.254"));
        assert!(!lets(&mut guarded, "", "fd00:ec2::254"));
        assert!(!lets(&mut guarded, "", "fe80::1%eth0"));
        assert!(lets(&mut guarded, "example.com", "93.184.216.34"));
    }

    #[test]
    fn a_bad_entry_or_address_is_refused() {
        for config in [
            r#"{"layers": [{"allow": ["10.0.0.0/33"]}]}"#,
            r#"{"layers": [{"allow": ["exa mple.com"]}]}"#,
            r#"{"layers": [{"allow": ["host.com/8"]}]}"#,
            r#"{"layers": [{"allow": ["*."]}]}"#,
            r#"{"layers": [{"deny": [""]}]}"#,
            r#"{"layers": [{"other": []}]}"#,
        ] {
            assert!(open(config.as_bytes()).is_err(), "{config}");
        }
        let mut allow = rule(r#"{"layers": [{"allow": ["10.0.0.0/8"]}]}"#);
        assert!(allow.test(b"example.com\0not an address").is_err());
    }
}
