//! The sync wire protocol: the message enum exchanged over the encrypted QUIC
//! stream, plus its byte (de)serialization.
//!
//! This half is pure: a [`Frame`] knows how to become bytes and back, and
//! that's it. The *length framing* (a `u32` length prefix per frame) and the
//! async read/write loop live in the desktop shell's transport, which owns the
//! tokio runtime and the `iroh` streams. Keeping the codec here means the exact
//! bytes on the wire are unit-tested without a socket.
//!
//! Frames are serialized with `postcard` (compact, `serde`-based, no_std-
//! friendly) — notably [`Frame::FileData`] carries already-**sealed**
//! ciphertext (see [`super::crypto`]), so even the transport bytes never expose
//! a note's contents.

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::sync::manifest::Manifest;

/// Protocol version, exchanged in [`Frame::Hello`]. A mismatch aborts the
/// session cleanly rather than risking a misread stream. v2 added the
/// vault-key challenge ([`Frame::Challenge`]/[`Frame::ChallengeResponse`])
/// that gates the manifest for unknown peers.
pub const PROTOCOL_VERSION: u8 = 2;

/// One message on the sync stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Frame {
    /// First message from each side: protocol version + which vault this is.
    /// A version or vault-id mismatch ends the session.
    Hello { version: u8, vault_id: String },
    /// Responder → an *unknown* initiator, after `Hello`: prove possession of
    /// the vault key by sealing this random nonce. Nothing else (in
    /// particular no manifest) is sent until the proof verifies.
    Challenge { nonce: Vec<u8> },
    /// Initiator → responder: the challenge nonce, sealed with the vault key
    /// (see `crypto`). Opening it and matching the nonce is the proof.
    ChallengeResponse { sealed: Vec<u8> },
    /// A side's full content manifest of its vault.
    Manifest(Manifest),
    /// "Send me this file" — used by the plan-driving side to pull a file it
    /// should take (or the peer's copy of a conflicted file).
    FileRequest { path: String },
    /// A file's **sealed** (E2E-encrypted) bytes. `path` is vault-relative.
    FileData { path: String, sealed: Vec<u8> },
    /// The requested path no longer exists on the sender (raced deletion).
    FileMissing { path: String },
    /// The sender has issued all the frames it intends to for this cycle.
    Done,
}

impl Frame {
    /// Serialize to bytes (no length prefix — the transport adds that).
    pub fn encode(&self) -> CoreResult<Vec<u8>> {
        postcard::to_stdvec(self)
            .map_err(|e| CoreError::Serde(format!("sync: frame encode failed: {e}")))
    }

    /// Deserialize a frame from exactly its bytes.
    pub fn decode(bytes: &[u8]) -> CoreResult<Frame> {
        postcard::from_bytes(bytes)
            .map_err(|e| CoreError::Serde(format!("sync: frame decode failed: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::sync::manifest::FileEntry;

    fn sample_manifest() -> Manifest {
        let mut entries = BTreeMap::new();
        entries.insert(
            "a.md".to_string(),
            FileEntry {
                path: "a.md".to_string(),
                hash: "deadbeef".to_string(),
                size: 5,
                mtime_ms: 42,
            },
        );
        Manifest { entries }
    }

    fn round_trip(frame: Frame) {
        let bytes = frame.encode().unwrap();
        assert_eq!(Frame::decode(&bytes).unwrap(), frame);
    }

    #[test]
    fn hello_round_trips() {
        round_trip(Frame::Hello {
            version: PROTOCOL_VERSION,
            vault_id: "vault-1".to_string(),
        });
    }

    #[test]
    fn challenge_frames_round_trip() {
        round_trip(Frame::Challenge {
            nonce: vec![7u8; 32],
        });
        round_trip(Frame::ChallengeResponse {
            sealed: vec![0u8, 255, 42],
        });
    }

    #[test]
    fn manifest_round_trips() {
        round_trip(Frame::Manifest(sample_manifest()));
    }

    #[test]
    fn file_data_round_trips_binary_payload() {
        round_trip(Frame::FileData {
            path: "notes/x.md".to_string(),
            sealed: vec![0u8, 255, 1, 2, 254, 128],
        });
    }

    #[test]
    fn request_missing_done_round_trip() {
        round_trip(Frame::FileRequest {
            path: "a.md".to_string(),
        });
        round_trip(Frame::FileMissing {
            path: "a.md".to_string(),
        });
        round_trip(Frame::Done);
    }

    #[test]
    fn decode_rejects_garbage() {
        assert!(Frame::decode(&[0xff, 0xff, 0xff, 0xff, 0xff]).is_err());
    }
}
