//! End-to-end encryption of vault file contents with the **vault key**.
//!
//! The vault key is a 32-byte symmetric secret shared only between paired
//! devices (it travels once, inside the pairing [`ticket`](super::ticket), and
//! otherwise lives in the OS keychain). File bytes are sealed with
//! XChaCha20-Poly1305 — an AEAD with a 192-bit random nonce, so we can pick
//! nonces randomly without a counter and never worry about reuse across the
//! many small messages a sync produces. Any relay or backup that carries the
//! resulting blob sees only ciphertext; without the vault key it cannot read a
//! single note. This is the property that makes the sync zero-knowledge.
//!
//! Distinct from the *device identity* ([`super::identity`]), which
//! authenticates the transport (who you're talking to) but does not by itself
//! grant the ability to read vault contents.

use chacha20poly1305::aead::{Aead, AeadCore, KeyInit};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;

use crate::error::{CoreError, CoreResult};

/// Length of the XChaCha20-Poly1305 nonce, prepended to every sealed blob.
const NONCE_LEN: usize = 24;
/// Length of the symmetric vault key.
pub const KEY_LEN: usize = 32;

/// The symmetric key that seals a vault's file contents. Shared only between
/// paired devices. `Clone` is intentional (the transport hands copies to the
/// session), but it must never be serialized into anything that leaves the
/// device except the pairing ticket.
#[derive(Clone)]
pub struct VaultKey([u8; KEY_LEN]);

impl VaultKey {
    /// Generate a fresh random vault key from the OS CSPRNG.
    pub fn generate() -> Self {
        let mut k = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut k);
        VaultKey(k)
    }

    /// Reconstruct a vault key from its raw 32 bytes (e.g. read back from the
    /// keychain or decoded from a ticket).
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        VaultKey(bytes)
    }

    /// The raw key bytes — for persisting to the OS keychain only.
    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }

    /// Seal `plaintext`, returning `nonce || ciphertext||tag`. A fresh random
    /// nonce is generated per call, so encrypting the same bytes twice yields
    /// different blobs (and reusing a nonce is astronomically unlikely).
    pub fn seal(&self, plaintext: &[u8]) -> CoreResult<Vec<u8>> {
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&self.0));
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(&nonce, plaintext)
            .map_err(|_| CoreError::Internal("sync: encryption failed".to_string()))?;
        let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        out.extend_from_slice(nonce.as_slice());
        out.extend_from_slice(&ciphertext);
        Ok(out)
    }

    /// Open a blob produced by [`VaultKey::seal`]. Fails (never silently
    /// returns garbage) if the key is wrong or the ciphertext was tampered
    /// with — the Poly1305 tag is verified before any plaintext is returned.
    pub fn open(&self, blob: &[u8]) -> CoreResult<Vec<u8>> {
        if blob.len() < NONCE_LEN {
            return Err(CoreError::BadRequest(
                "sync: sealed blob is too short to contain a nonce".to_string(),
            ));
        }
        let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
        let cipher = XChaCha20Poly1305::new(Key::from_slice(&self.0));
        cipher
            .decrypt(XNonce::from_slice(nonce), ciphertext)
            .map_err(|_| {
                CoreError::BadRequest(
                    "sync: decryption failed (wrong vault key or corrupted data)".to_string(),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_arbitrary_bytes() {
        let key = VaultKey::generate();
        for body in [
            &b""[..],
            b"hello",
            &[0u8; 4096][..],
            "# Note\n\ncontent".as_bytes(),
        ] {
            let sealed = key.seal(body).unwrap();
            assert_eq!(key.open(&sealed).unwrap(), body);
        }
    }

    #[test]
    fn nonce_is_prepended_and_ciphertext_differs_from_plaintext() {
        let key = VaultKey::generate();
        let body = b"secret note body";
        let sealed = key.seal(body).unwrap();
        assert!(
            sealed.len() > NONCE_LEN + body.len(),
            "must carry nonce + tag"
        );
        assert!(
            !sealed.windows(body.len()).any(|w| w == body),
            "plaintext must not appear in the sealed blob"
        );
    }

    #[test]
    fn same_plaintext_seals_to_different_blobs() {
        let key = VaultKey::generate();
        let a = key.seal(b"same").unwrap();
        let b = key.seal(b"same").unwrap();
        assert_ne!(a, b, "random nonce must make repeated seals differ");
    }

    #[test]
    fn wrong_key_cannot_open() {
        let sealed = VaultKey::generate().seal(b"top secret").unwrap();
        let err = VaultKey::generate().open(&sealed).unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)), "got: {err:?}");
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let key = VaultKey::generate();
        let mut sealed = key.seal(b"authentic").unwrap();
        // Flip a bit in the ciphertext body (past the nonce).
        let last = sealed.len() - 1;
        sealed[last] ^= 0x01;
        assert!(key.open(&sealed).is_err(), "AEAD tag must reject tampering");
    }

    #[test]
    fn from_bytes_reconstructs_a_usable_key() {
        let key = VaultKey::generate();
        let sealed = key.seal(b"persisted").unwrap();
        let restored = VaultKey::from_bytes(*key.as_bytes());
        assert_eq!(restored.open(&sealed).unwrap(), b"persisted");
    }

    #[test]
    fn too_short_blob_is_a_bad_request_not_a_panic() {
        let key = VaultKey::generate();
        assert!(key.open(&[0u8; 8]).is_err());
    }
}
