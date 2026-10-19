#[cfg(test)]
mod portable_tests {
  use super::*;
  use std::{future::Future, task::{Context, Poll, Waker}};

  fn run<T>(future: impl Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
      Poll::Ready(value) => value,
      Poll::Pending => panic!("host shim must complete synchronously"),
    }
  }
  struct Fixture { root: PathBuf, window: WebviewWindow }
  impl Fixture {
    fn new() -> Self {
      let id = SEQ.fetch_add(1, Ordering::Relaxed);
      let root = std::env::temp_dir().join(format!("baton-drop-test-{}-{id}", std::process::id()));
      std::fs::create_dir(&root).unwrap();
      let window = WebviewWindow::new(&format!("test-{id}"));
      configure_window(&window);
      Self { root, window }
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
      let path = self.root.join(name);
      std::fs::write(&path, bytes).unwrap();
      path
    }
  }
  impl Drop for Fixture {
    fn drop(&mut self) { self.window.destroy(); let _ = std::fs::remove_dir_all(&self.root); }
  }

  #[test]
  fn unrelated_window_events_do_not_emit_file_drops() {
    let fixture = Fixture::new();
    fixture.window.other_event();
    assert!(fixture.window.emitted.lock().unwrap().is_empty());
  }

  #[test]
  fn native_drop_is_window_scoped_single_claim_and_preserves_names() {
    let fixture = Fixture::new();
    let path = fixture.file("中文 space.png", b"image");
    let tokens = fixture.window.drop_files(vec![path.clone(), path]);
    assert_eq!(fixture.window.emitted.lock().unwrap().last().unwrap().2["width"], 1024.0);
    assert_eq!(tokens.len(), 1);
    let token = tokens[0].clone();
    let other = WebviewWindow::new("other");
    assert!(run(macos_drop_claim(other.clone(), token.clone())).is_err());
    let descriptor = run(macos_drop_claim(fixture.window.clone(), token.clone())).unwrap();
    assert_eq!(descriptor.name, "中文 space.png");
    assert_eq!(descriptor.size, 5);
    assert!(descriptor.image);
    assert!(run(macos_drop_claim(fixture.window.clone(), token.clone())).is_err());
    assert!(run(macos_drop_read_image(other.clone(), token.clone())).is_err());
    macos_drop_release(other, token.clone()).unwrap();
    assert_eq!(run(macos_drop_read_image(fixture.window.clone(), token.clone())).unwrap().0, b"image");
    macos_drop_release(fixture.window.clone(), token.clone()).unwrap();
    assert!(access(fixture.window.label(), &token).is_err());
    assert!(fixture.window.emitted.lock().unwrap().iter().all(|event| event.0 == fixture.window.label()));
  }

  #[test]
  fn reject_folders_oversize_expired_unknown_and_unclaimed_reads() {
    let fixture = Fixture::new();
    let folder = fixture.window.drop_files(vec![fixture.root.clone()])[0].clone();
    assert!(run(macos_drop_claim(fixture.window.clone(), folder)).unwrap_err().contains("ZIP"));
    let path = fixture.file("huge.zip", b"");
    File::options().write(true).open(&path).unwrap().set_len(MAX_BYTES + 1).unwrap();
    let token = fixture.window.drop_files(vec![path])[0].clone();
    assert!(run(macos_drop_claim(fixture.window.clone(), token)).unwrap_err().contains("512"));
    let path = fixture.file("small.png", b"x");
    let token = fixture.window.drop_files(vec![path])[0].clone();
    assert!(access(fixture.window.label(), &token).is_err());
    grants().lock().unwrap().get_mut(&token).unwrap().created = Instant::now() - Duration::from_secs(121);
    assert!(run(macos_drop_claim(fixture.window.clone(), token)).unwrap_err().contains("expired"));
    assert!(run(macos_drop_claim(fixture.window.clone(), "/etc/passwd".into())).is_err());
  }

  #[test]
  fn streaming_reader_bounds_memory_tracks_progress_and_honors_cancel() {
    let fixture = Fixture::new();
    let path = fixture.file("large.zip", b"");
    let file = File::options().read(true).write(true).open(&path).unwrap();
    file.set_len(64 * 1024 * 1024).unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut stream = UploadReader { file, cancelled: cancelled.clone(), window: fixture.window.clone(),
      token: "progress".into(), size: 64 * 1024 * 1024, read: 0, percent: 0 };
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0;
    loop {
      let count = stream.read(&mut buffer).unwrap();
      if count == 0 { break; }
      total += count;
    }
    assert_eq!(total, 64 * 1024 * 1024);
    let events = fixture.window.emitted.lock().unwrap();
    assert!(events.len() <= 100);
    assert_eq!(events.last().unwrap().2["progress"], 99);
    drop(events);
    cancelled.store(true, Ordering::Relaxed);
    assert!(stream.read(&mut buffer).is_err());
  }

  #[test]
  fn changed_files_duplicate_read_and_non_https_upload_fail_without_network() {
    let fixture = Fixture::new();
    let path = fixture.file("file.zip", b"original");
    let token = fixture.window.drop_files(vec![path.clone()])[0].clone();
    run(macos_drop_claim(fixture.window.clone(), token.clone())).unwrap();
    let (_, _, _, _, busy) = access(fixture.window.label(), &token).unwrap();
    assert!(access(fixture.window.label(), &token).is_err());
    busy.store(false, Ordering::SeqCst);
    assert!(run(macos_drop_upload(fixture.window.clone(), token.clone(),
      vec!["http://localhost/upload".into()], HashMap::new())).unwrap_err().contains("HTTPS"));
    std::fs::write(&path, b"changed size").unwrap();
    assert!(run(macos_drop_read_image(fixture.window.clone(), token.clone())).is_err());
    fixture.window.destroy();
    assert!(access(fixture.window.label(), &token).is_err());
  }
}
