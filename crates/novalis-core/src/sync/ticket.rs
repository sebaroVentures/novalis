//! The pairing **ticket**: the one shareable string that lets a second device
//! join a vault's sync.
//!
//! A ticket carries everything the joiner needs and nothing it doesn't:
//! - `vault_id` — which logical vault this is (both devices must agree).
//! - `node_id` + `relay` + `addrs` — how to reach the generating device's QUIC
//!   endpoint (node id = its public key; relay/direct-addr hints for dialing).
//! - `vault_key` — the symmetric key that decrypts the vault's file contents.
//!
//! ## Security boundary (stated plainly)
//! The ticket **is** the secret: anyone who obtains it can read the vault
//! (it contains the vault key) and pair as a device. It must be transferred
//! out-of-band over a channel the user trusts (AirDrop, a password manager, a
//! QR shown on-screen) and is single-use by intent. A PAKE/short-PIN exchange
//! (Magic-Wormhole style) that would let two devices agree on the key *without*
//! ever transmitting it is the documented hardening step; this foundation does
//! not implement it. The node id still authenticates the transport, so a relay
//! that carries the *later* traffic never sees plaintext — but the ticket
//! itself is bearer-secret.

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::sync::crypto::{VaultKey, KEY_LEN};
use crate::sync::identity::SEED_LEN;

/// Human-recognizable scheme prefix on the encoded ticket string.
const TICKET_PREFIX: &str = "novalis-sync1:";
/// Ticket format version. Bumped on any breaking change to [`Payload`].
const TICKET_VERSION: u8 = 1;

/// The decoded contents of a pairing ticket. Holds the secret vault key, so it
/// must never be serialized to anything that leaves the device except via
/// [`SyncTicket::encode`] (which is the deliberate, out-of-band transfer).
pub struct SyncTicket {
    pub vault_id: String,
    /// The generating device's 32-byte node id (ed25519 public key).
    pub node_id: [u8; SEED_LEN],
    /// Optional relay URL for NAT traversal when direct dialing fails.
    pub relay_url: Option<String>,
    /// Direct socket addresses (`ip:port`) to try first — populated for LAN /
    /// relay-less pairing.
    pub direct_addrs: Vec<String>,
    pub vault_key: VaultKey,
}

/// Wire form: compact, base64url-encoded JSON. (JSON keeps it debuggable; the
/// encoded string is what the user copies.)
#[derive(Serialize, Deserialize)]
struct Payload {
    v: u8,
    vault_id: String,
    /// hex node id.
    node: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relay: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    addrs: Vec<String>,
    /// hex vault key.
    key: String,
}

impl SyncTicket {
    /// Encode to the shareable `novalis-sync1:<base64url>` string.
    pub fn encode(&self) -> CoreResult<String> {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine as _;

        let payload = Payload {
            v: TICKET_VERSION,
            vault_id: self.vault_id.clone(),
            node: to_hex(&self.node_id),
            relay: self.relay_url.clone(),
            addrs: self.direct_addrs.clone(),
            key: to_hex(self.vault_key.as_bytes()),
        };
        let json = serde_json::to_vec(&payload)?;
        Ok(format!("{TICKET_PREFIX}{}", URL_SAFE_NO_PAD.encode(json)))
    }

    /// Decode and validate a ticket string. Rejects the wrong prefix, an
    /// unknown version, malformed base64/JSON, and wrong-length keys — a
    /// caller can surface any of these as "invalid pairing code".
    pub fn decode(s: &str) -> CoreResult<Self> {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine as _;

        let body = s.trim().strip_prefix(TICKET_PREFIX).ok_or_else(|| {
            CoreError::BadRequest("sync: not a Novalis pairing ticket".to_string())
        })?;
        let json = URL_SAFE_NO_PAD
            .decode(body.as_bytes())
            .map_err(|_| CoreError::BadRequest("sync: malformed pairing ticket".to_string()))?;
        let payload: Payload = serde_json::from_slice(&json)
            .map_err(|_| CoreError::BadRequest("sync: unreadable pairing ticket".to_string()))?;

        if payload.v != TICKET_VERSION {
            return Err(CoreError::BadRequest(format!(
                "sync: unsupported ticket version {} (this build speaks {TICKET_VERSION})",
                payload.v
            )));
        }
        if payload.vault_id.trim().is_empty() {
            return Err(CoreError::BadRequest(
                "sync: ticket is missing a vault id".to_string(),
            ));
        }

        let node_id: [u8; SEED_LEN] = decode_hex(&payload.node)?
            .try_into()
            .map_err(|_| CoreError::BadRequest("sync: ticket node id must be 32 bytes".to_string()))?;
        let key_bytes: [u8; KEY_LEN] = decode_hex(&payload.key)?
            .try_into()
            .map_err(|_| CoreError::BadRequest("sync: ticket key must be 32 bytes".to_string()))?;

        Ok(SyncTicket {
            vault_id: payload.vault_id,
            node_id,
            relay_url: payload.relay,
            direct_addrs: payload.addrs,
            vault_key: VaultKey::from_bytes(key_bytes),
        })
    }

    /// Short, display-only fingerprint of the node id (first 8 hex chars) for
    /// labelling a peer in the UI.
    pub fn node_short(&self) -> String {
        to_hex(&self.node_id).chars().take(8).collect()
    }
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(hex: &str) -> CoreResult<Vec<u8>> {
    let hex = hex.trim();
    if hex.len() % 2 != 0 {
        return Err(CoreError::BadRequest("sync: hex has odd length".to_string()));
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16)
                .map_err(|_| CoreError::BadRequest("sync: invalid hex".to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SyncTicket {
        SyncTicket {
            vault_id: "vault-abc".to_string(),
            node_id: [7u8; SEED_LEN],
            relay_url: Some("https://relay.example".to_string()),
            direct_addrs: vec!["192.168.1.5:4433".to_string(), "[::1]:4433".to_string()],
            vault_key: VaultKey::from_bytes([9u8; KEY_LEN]),
        }
    }

    #[test]
    fn round_trips_all_fields() {
        let t = sample();
        let decoded = SyncTicket::decode(&t.encode().unwrap()).unwrap();
        assert_eq!(decoded.vault_id, "vault-abc");
        assert_eq!(decoded.node_id, [7u8; SEED_LEN]);
        assert_eq!(decoded.relay_url.as_deref(), Some("https://relay.example"));
        assert_eq!(decoded.direct_addrs, vec!["192.168.1.5:4433", "[::1]:4433"]);
        assert_eq!(decoded.vault_key.as_bytes(), &[9u8; KEY_LEN]);
    }

    #[test]
    fn round_trips_without_relay_or_addrs() {
        let t = SyncTicket {
            relay_url: None,
            direct_addrs: vec![],
            ..sample()
        };
        let decoded = SyncTicket::decode(&t.encode().unwrap()).unwrap();
        assert_eq!(decoded.relay_url, None);
        assert!(decoded.direct_addrs.is_empty());
    }

    #[test]
    fn encoded_string_carries_the_scheme_prefix() {
        assert!(sample().encode().unwrap().starts_with(TICKET_PREFIX));
    }

    #[test]
    fn node_short_is_eight_hex_chars() {
        assert_eq!(sample().node_short(), "07070707");
    }

    #[test]
    fn rejects_wrong_prefix() {
        assert!(SyncTicket::decode("https://not-a-ticket").is_err());
    }

    #[test]
    fn rejects_corrupt_base64() {
        assert!(SyncTicket::decode("novalis-sync1:@@@not-base64@@@").is_err());
    }

    #[test]
    fn rejects_future_version() {
        // Hand-build a v99 payload and confirm decode refuses it.
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine as _;
        let payload = Payload {
            v: 99,
            vault_id: "v".to_string(),
            node: to_hex(&[0u8; SEED_LEN]),
            relay: None,
            addrs: vec![],
            key: to_hex(&[0u8; KEY_LEN]),
        };
        let s = format!(
            "{TICKET_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
        );
        // `unwrap_err` would need `SyncTicket: Debug`, which we deliberately
        // withhold (it carries the vault key) — match on the error instead.
        assert!(matches!(
            SyncTicket::decode(&s),
            Err(CoreError::BadRequest(_))
        ));
    }

    #[test]
    fn rejects_wrong_key_length() {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine as _;
        let payload = Payload {
            v: TICKET_VERSION,
            vault_id: "v".to_string(),
            node: to_hex(&[0u8; SEED_LEN]),
            relay: None,
            addrs: vec![],
            key: "abcd".to_string(), // 2 bytes, not 32
        };
        let s = format!(
            "{TICKET_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
        );
        assert!(SyncTicket::decode(&s).is_err());
    }
}
