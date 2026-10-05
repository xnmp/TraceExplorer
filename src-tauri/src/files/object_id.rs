//! Pure native object identity. Identity is not a content version or a durable
//! handle: filesystems can reuse identifiers after the original object is gone.
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize)]
#[serde(transparent)]
pub(crate) struct ObjectId(Identity);

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "lowercase", deny_unknown_fields)]
enum Identity {
    Linux {
        device: u64,
        inode: u64,
    },
    Macos {
        device: u64,
        inode: u64,
    },
    Windows {
        #[serde(rename = "volumeSerial")]
        volume_serial: u64,
        #[serde(rename = "fileId")]
        file_id: [u8; 16],
    },
}

impl ObjectId {
    /// Largest native JSON identity, including its platform tag and keys.
    /// Resource admission uses this before allocating serialized claim arrays.
    #[cfg(any(unix, test))]
    pub(super) const MAX_ENCODED_BYTES: usize = if cfg!(windows) { 133 } else { 79 };

    #[cfg(unix)]
    pub(super) fn unix(device: u64, inode: u64) -> Self {
        #[cfg(target_os = "linux")]
        let identity = Identity::Linux { device, inode };
        #[cfg(target_os = "macos")]
        let identity = Identity::Macos { device, inode };
        Self(identity)
    }

    #[cfg(windows)]
    pub(super) fn windows(volume_serial: u64, file_id: [u8; 16]) -> Self {
        Self(Identity::Windows {
            volume_serial,
            file_id,
        })
    }

    /// This platform's device and inode, for compact same-platform encodings;
    /// `None` for an identity another platform recorded.
    #[cfg(unix)]
    pub(super) fn unix_parts(self) -> Option<(u64, u64)> {
        match self.0 {
            Identity::Linux { device, inode } | Identity::Macos { device, inode } => {
                (Self::unix(device, inode) == self).then_some((device, inode))
            }
            Identity::Windows { .. } => None,
        }
    }

    /// Volume equality is weaker than object equality and never crosses an OS
    /// namespace, even when the numeric volume identifiers happen to match.
    #[cfg(any(unix, test))]
    pub(super) fn same_volume(self, other: Self) -> bool {
        self.0.volume() == other.0.volume()
    }
}

impl Identity {
    fn volume(self) -> (&'static str, u64) {
        match self {
            Self::Linux { device, .. } => ("linux", device),
            Self::Macos { device, .. } => ("macos", device),
            Self::Windows { volume_serial, .. } => ("windows", volume_serial),
        }
    }
}

impl<'de> Deserialize<'de> for ObjectId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let identity = Identity::deserialize(deserializer)?;
        if identity.volume().0 != std::env::consts::OS {
            return Err(serde::de::Error::custom(
                "Recovery object identity belongs to an unsupported platform",
            ));
        }
        Ok(Self(identity))
    }
}
