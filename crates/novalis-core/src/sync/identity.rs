//! Per-device identity: the 32-byte secret seed that keys this device's QUIC
//! endpoint.
//!
//! `iroh` derives an ed25519 keypair from this seed; the public half is the
//! device's stable **node id** (what a peer dials and what authenticates the
//! encrypted channel). The seed is a secret — it lives in the OS keychain, not
//! in the vault — and this type is just its pure, testable representation
//! (generate + hex round-trip). The actual ed25519/QUIC operations belong to
//! the transport in the desktop shell; keeping them out of core avoids pulling
//! the signature stack into the unit-tested half.

use rand::rngs::OsRng;
use rand::RngCore;

use crate::error::{CoreError, CoreResult};

/// Length of the device secret seed (an ed25519 seed, per `iroh::SecretKey`).
pub const SEED_LEN: usize = 32;

/// This device's identity seed. Generated once per device and persisted in the
/// OS keychain; every QUIC connection this device makes is authenticated by the
/// node id derived from it.
#[derive(Clone)]
pub struct DeviceIdentity([u8; SEED_LEN]);

impl DeviceIdentity {
    /// Generate a fresh identity from the OS CSPRNG.
    pub fn generate() -> Self {
        let mut seed = [0u8; SEED_LEN];
        OsRng.fill_bytes(&mut seed);
        DeviceIdentity(seed)
    }

    /// Reconstruct from raw seed bytes (read back from the keychain).
    pub fn from_seed(seed: [u8; SEED_LEN]) -> Self {
        DeviceIdentity(seed)
    }

    /// The raw seed — for persisting to the keychain and for handing to the
    /// transport to build the QUIC secret key.
    pub fn seed(&self) -> &[u8; SEED_LEN] {
        &self.0
    }

    /// Lowercase-hex encoding of the seed, for keychain storage.
    pub fn to_hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Parse a hex-encoded seed produced by [`DeviceIdentity::to_hex`].
    pub fn from_hex(hex: &str) -> CoreResult<Self> {
        let bytes = decode_hex(hex)?;
        let seed: [u8; SEED_LEN] = bytes.try_into().map_err(|_| {
            CoreError::BadRequest("sync: device seed must be 32 bytes".to_string())
        })?;
        Ok(DeviceIdentity(seed))
    }
}

/// Decode an even-length lowercase/uppercase hex string to bytes.
fn decode_hex(hex: &str) -> CoreResult<Vec<u8>> {
    let hex = hex.trim();
    if hex.len() % 2 != 0 {
        return Err(CoreError::BadRequest(
            "sync: hex string has odd length".to_string(),
        ));
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

    #[test]
    fn hex_round_trips() {
        let id = DeviceIdentity::generate();
        let restored = DeviceIdentity::from_hex(&id.to_hex()).unwrap();
        assert_eq!(id.seed(), restored.seed());
    }

    #[test]
    fn hex_is_64_chars() {
        assert_eq!(DeviceIdentity::generate().to_hex().len(), 64);
    }

    #[test]
    fn generate_is_not_all_zero_and_differs() {
        let a = DeviceIdentity::generate();
        let b = DeviceIdentity::generate();
        assert_ne!(a.seed(), &[0u8; SEED_LEN]);
        assert_ne!(a.seed(), b.seed());
    }

    #[test]
    fn rejects_wrong_length() {
        assert!(DeviceIdentity::from_hex("deadbeef").is_err());
    }

    #[test]
    fn rejects_non_hex() {
        assert!(DeviceIdentity::from_hex(&"zz".repeat(32)).is_err());
    }

    #[test]
    fn rejects_odd_length() {
        assert!(DeviceIdentity::from_hex("abc").is_err());
    }
}
