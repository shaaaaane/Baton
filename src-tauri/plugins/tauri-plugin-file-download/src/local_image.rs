use base64::{engine::general_purpose::STANDARD, Engine};
use std::{io::Write, path::{Path, PathBuf}};

pub const MAX_BYTES: usize = 32 * 1024 * 1024;

pub fn decode(url: &str) -> Result<Vec<u8>, String> {
    let comma = url.as_bytes().iter().take(64).position(|c| *c == b',')
        .ok_or("Invalid image data URL")?;
    let mime = url[..comma].strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or("Invalid image data URL")?;
    if !matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml") {
        return Err("Unsupported image MIME type".into());
    }
    let encoded = &url[comma + 1..];
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("Image exceeds 32 MiB".into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| "Invalid base64 image")?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("Image must contain 1 byte to 32 MiB".into());
    }
    Ok(bytes)
}

pub fn save(url: &str, directory: &Path, name: &str) -> Result<PathBuf, String> {
    let bytes = decode(url)?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let (path, mut file) = crate::filename::reserve_file(directory, name).map_err(|e| e.to_string())?;
    let result = file.write_all(&bytes).and_then(|_| file.flush());
    drop(file);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&path);
        return Err(error.to_string());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_utf8_and_rejects_invalid_input() {
        let bytes = "<svg><text>中文 &amp; café</text></svg>".as_bytes();
        assert_eq!(decode(&format!("data:image/svg+xml;base64,{}", STANDARD.encode(bytes))).unwrap(), bytes);
        for url in ["file:///tmp/x", "data:text/html;base64,YQ==", "data:image/png;base64,",
            "data:image/png;base64,YQ", "data:image/png;base64,YR==", "data:image/png;base64,@@@="] {
            assert!(decode(url).is_err(), "{url}");
        }
    }
    #[test]
    fn enforces_inclusive_size_limit() {
        let bytes = vec![42; MAX_BYTES];
        assert_eq!(decode(&format!("data:image/png;base64,{}", STANDARD.encode(&bytes))).unwrap(), bytes);
        assert!(decode(&format!("data:image/png;base64,{}", STANDARD.encode(vec![42; MAX_BYTES + 1]))).is_err());
    }
    #[test]
    fn saves_original_bytes_without_overwriting_or_escaping_downloads() {
        let directory = std::env::temp_dir().join(format!("baton-image-export-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let url = "data:image/png;base64,iVBORwABAP8=";
        let first = save(url, &directory, "../图表.png").unwrap();
        let second = save(url, &directory, "../图表.png").unwrap();
        assert_eq!(first.parent(), Some(directory.as_path()));
        assert_ne!(first, second);
        assert_eq!(std::fs::read(first).unwrap(), STANDARD.decode("iVBORwABAP8=").unwrap());
        assert!(save("data:text/html;base64,YQ==", &directory, "bad.html").is_err());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
