use std::{
  collections::{HashMap, HashSet},
  fs::File,
  io::{Read, Seek, SeekFrom},
  os::unix::fs::MetadataExt,
  path::PathBuf,
  sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex, OnceLock},
  time::{Duration, Instant, SystemTime},
};
use serde::Serialize;
use tauri::{DragDropEvent, Emitter, WindowEvent, WebviewWindow};

const MAX_BYTES: u64 = 512 * 1024 * 1024;
const IMAGE_BYTES: u64 = 32 * 1024 * 1024;
static SEQ: AtomicU64 = AtomicU64::new(0);
static GRANTS: OnceLock<Mutex<HashMap<String, Grant>>> = OnceLock::new();

struct Grant {
  owner: String,
  path: PathBuf,
  created: Instant,
  file: Option<Arc<File>>,
  size: u64,
  modified: Option<SystemTime>,
  cancelled: Arc<AtomicBool>,
  busy: Arc<AtomicBool>,
}

fn grants() -> &'static Mutex<HashMap<String, Grant>> {
  GRANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
  token: String,
  name: String,
  size: u64,
  image: bool,
  identity: String,
}

pub fn configure_window(window: &WebviewWindow) {
  let target = window.clone();
  window.on_window_event(move |event| {
    if matches!(event, WindowEvent::Destroyed) {
      if let Ok(mut grants) = grants().lock() {
        grants.retain(|_, grant| {
          if grant.owner == target.label() { grant.cancelled.store(true, Ordering::Relaxed); false } else { true }
        });
      }
      return;
    }
    let WindowEvent::DragDrop(event) = event else { return };
    let mut payload = serde_json::json!({});
    match event {
      DragDropEvent::Enter { position, .. } | DragDropEvent::Over { position } => {
        payload["type"] = "over".into();
        payload["position"] = serde_json::json!({ "x": position.x, "y": position.y });
      }
      DragDropEvent::Leave => { payload["type"] = "leave".into(); }
      DragDropEvent::Drop { paths, position } => {
        let Ok(mut grants) = grants().lock() else { return };
        grants.retain(|_, grant| grant.file.is_some() || grant.created.elapsed() < Duration::from_secs(120));
        let mut seen = HashSet::new();
        let mut tokens = Vec::new();
        let mut overflow = false;
        for path in paths {
          if !seen.insert(path.clone()) { continue; }
          if grants.len() >= 256 { overflow = true; continue; }
          let token = format!("drop-{}", SEQ.fetch_add(1, Ordering::Relaxed));
          grants.insert(token.clone(), Grant {
            owner: target.label().to_owned(), path: path.clone(), created: Instant::now(),
            file: None, size: 0, modified: None,
            cancelled: Arc::new(AtomicBool::new(false)), busy: Arc::new(AtomicBool::new(false)),
          });
          tokens.push(token);
        }
        payload = serde_json::json!({
          "type": "drop", "tokens": tokens, "position": { "x": position.x, "y": position.y },
          "overflow": overflow,
        });
      }
      _ => return,
    }
    // Wry's macOS drag positions are AppKit points, not backing pixels.
    if let (Ok(size), Ok(scale)) = (target.inner_size(), target.scale_factor()) {
      payload["width"] = (size.width as f64 / scale).into();
    }
    let _ = target.emit_to(target.label(), "macos-file-drop", payload);
  });
}

fn image_name(name: &str) -> bool {
  matches!(name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str(),
    "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "avif" | "heic" | "heif")
}

#[tauri::command]
pub async fn macos_drop_claim(window: WebviewWindow, token: String) -> Result<DroppedFile, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let (path, busy) = {
      let grants = grants().lock().map_err(|_| "File access unavailable")?;
      let grant = grants.get(&token).filter(|grant| grant.owner == window.label())
        .ok_or("This file was not dropped into this window")?;
      if grant.file.is_some() { return Err("File already added".into()); }
      if grant.created.elapsed() >= Duration::from_secs(120) { return Err("Drop expired; drag the file again".into()); }
      if grant.busy.swap(true, Ordering::SeqCst) { return Err("File already being claimed".into()); }
      (grant.path.clone(), grant.busy.clone())
    };
    let _busy = Busy(busy);
    let path_metadata = std::fs::metadata(&path).map_err(|_| "Could not inspect the dropped file")?;
    if path_metadata.is_dir() { return Err("Compress folders to a ZIP before uploading".into()); }
    if !path_metadata.is_file() { return Err("Only ordinary files can be uploaded".into()); }
    let file = File::open(&path).map_err(|_| "Could not read the dropped file")?;
    let metadata = file.metadata().map_err(|_| "Could not inspect the dropped file")?;
    if !metadata.is_file() { return Err("Compress folders to a ZIP before uploading".into()); }
    if metadata.len() > MAX_BYTES { return Err("File exceeds the 512 MB limit".into()); }
    let name = path.file_name().ok_or("Missing file name")?.to_string_lossy().into_owned();
    let mut grants = grants().lock().map_err(|_| "File access unavailable")?;
    let grant = grants.get_mut(&token).ok_or("Drop was removed")?;
    grant.size = metadata.len();
    grant.modified = metadata.modified().ok();
    grant.file = Some(Arc::new(file));
    Ok(DroppedFile {
      token, image: image_name(&name) && metadata.len() <= IMAGE_BYTES, name, size: metadata.len(),
      identity: format!("{}:{}:{}:{}:{}", metadata.dev(), metadata.ino(), metadata.mtime(), metadata.mtime_nsec(), metadata.len()),
    })
  }).await.map_err(|_| "Could not inspect dropped file")?
}

type FileAccess = (Arc<File>, u64, Option<SystemTime>, Arc<AtomicBool>, Arc<AtomicBool>);
fn access(owner: &str, token: &str) -> Result<FileAccess, String> {
  let grants = grants().lock().map_err(|_| "File access unavailable")?;
  let grant = grants.get(token).filter(|grant| grant.owner == owner).ok_or("Drop access expired")?;
  let file = grant.file.clone().ok_or("Claim the drop before reading")?;
  if grant.cancelled.load(Ordering::Relaxed) { return Err("Upload cancelled".into()); }
  if grant.busy.swap(true, Ordering::SeqCst) { return Err("File is already being read".into()); }
  Ok((file, grant.size, grant.modified, grant.cancelled.clone(), grant.busy.clone()))
}

struct Busy(Arc<AtomicBool>);
impl Drop for Busy {
  fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); }
}

fn reader(file: &File, size: u64, modified: Option<SystemTime>) -> Result<File, String> {
  let metadata = file.metadata().map_err(|_| "File is unavailable")?;
  if metadata.len() != size || metadata.modified().ok() != modified {
    return Err("File changed; remove it and drag the updated file again".into());
  }
  let mut file = file.try_clone().map_err(|_| "Could not read file")?;
  file.seek(SeekFrom::Start(0)).map_err(|_| "Could not read file")?;
  Ok(file)
}

#[tauri::command]
pub async fn macos_drop_read_image(window: WebviewWindow, token: String) -> Result<tauri::ipc::Response, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let (file, size, modified, cancelled, busy) = access(window.label(), &token)?;
    let _busy = Busy(busy);
    if size > IMAGE_BYTES { return Err("Use the file upload path for large images".into()); }
    let mut bytes = Vec::with_capacity(size as usize);
    reader(&file, size, modified)?.take(IMAGE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "Could not read image")?;
    if bytes.len() as u64 != size || cancelled.load(Ordering::Relaxed) { return Err("Image changed or was removed".into()); }
    Ok(tauri::ipc::Response::new(bytes))
  }).await.map_err(|_| "Could not read image")?
}

struct UploadReader {
  file: File,
  cancelled: Arc<AtomicBool>,
  window: WebviewWindow,
  token: String,
  size: u64,
  read: u64,
  percent: u64,
}
impl Read for UploadReader {
  fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
    if self.cancelled.load(Ordering::Relaxed) {
      return Err(std::io::Error::new(std::io::ErrorKind::Other, "Upload cancelled"));
    }
    let count = self.file.read(buffer)?;
    self.read += count as u64;
    let percent = (self.read * 100 / self.size.max(1)).min(99);
    if percent != self.percent {
      self.percent = percent;
      let _ = self.window.emit_to(self.window.label(), "macos-file-progress",
        serde_json::json!({ "token": self.token, "progress": percent }));
    }
    Ok(count)
  }
}

#[tauri::command]
pub async fn macos_drop_upload(
  window: WebviewWindow, token: String, urls: Vec<String>, headers: HashMap<String, String>,
) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let (file, size, modified, cancelled, busy) = access(window.label(), &token)?;
    let _busy = Busy(busy);
    if urls.is_empty() || urls.len() > 2 { return Err("No upload URL".into()); }
    let client = reqwest::blocking::Client::builder()
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(3600))
      .build().map_err(|_| "Upload unavailable")?;
    for (index, url) in urls.iter().enumerate() {
      let url = reqwest::Url::parse(url).map_err(|_| "Invalid upload URL")?;
      if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Uploads require HTTPS without embedded credentials".into());
      }
      if cancelled.load(Ordering::Relaxed) { return Err("Upload cancelled".into()); }
      let body = UploadReader {
        file: reader(&file, size, modified)?, cancelled: cancelled.clone(), window: window.clone(),
        token: token.clone(), size, read: 0, percent: 0,
      };
      let mut request = client.put(url).body(reqwest::blocking::Body::sized(body, size));
      for (name, value) in &headers { request = request.header(name.as_str(), value.as_str()); }
      let result = request.send();
      if cancelled.load(Ordering::Relaxed) { return Err("Upload cancelled".into()); }
      if result.as_ref().is_ok_and(|response| response.status().is_success()) { return Ok(()); }
      if index + 1 == urls.len() {
        return Err(match result {
          Ok(response) => format!("Upload failed ({})", response.status().as_u16()),
          Err(_) => "Upload failed. Check your connection.".into(),
        });
      }
    }
    Err("Upload failed".into())
  }).await.map_err(|_| "Upload interrupted")?
}

#[tauri::command]
pub fn macos_drop_release(window: WebviewWindow, token: String) -> Result<(), String> {
  let mut grants = grants().lock().map_err(|_| "File access unavailable")?;
  if grants.get(&token).is_some_and(|grant| grant.owner == window.label()) {
    if let Some(grant) = grants.remove(&token) { grant.cancelled.store(true, Ordering::Relaxed); }
  }
  Ok(())
}
