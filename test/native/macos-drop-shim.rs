#![allow(dead_code, unreachable_patterns)]
mod tauri {
  use std::sync::{Arc, Mutex};
  type Handler<T> = Arc<Mutex<Option<Box<dyn Fn(&T) + Send>>>>;
  #[derive(Clone)]
  pub struct WebviewWindow {
    label: String,
    drop_handler: Handler<WebviewEvent>,
    window_handler: Handler<WindowEvent>,
    pub emitted: Arc<Mutex<Vec<(String, String, serde_json::Value)>>>,
  }
  impl WebviewWindow {
    pub fn new(label: &str) -> Self {
      Self { label: label.into(), drop_handler: Default::default(),
        window_handler: Default::default(), emitted: Default::default() }
    }
    pub fn label(&self) -> &str { &self.label }
    pub fn inner_size(&self) -> Result<Size, String> { Ok(Size { width: 2048 }) }
    pub fn scale_factor(&self) -> Result<f64, String> { Ok(2.0) }
    pub fn on_webview_event(&self, f: impl Fn(&WebviewEvent) + Send + 'static) {
      *self.drop_handler.lock().unwrap() = Some(Box::new(f));
    }
    pub fn on_window_event(&self, f: impl Fn(&WindowEvent) + Send + 'static) {
      *self.window_handler.lock().unwrap() = Some(Box::new(f));
    }
    pub fn drop_files(&self, paths: Vec<std::path::PathBuf>) -> Vec<String> {
      let event = WindowEvent::DragDrop(DragDropEvent::Drop { paths, position: Position { x: 2.0, y: 3.0 } });
      self.window_handler.lock().unwrap().as_ref().unwrap()(&event);
      self.emitted.lock().unwrap().last().unwrap().2["tokens"].as_array().unwrap()
        .iter().map(|token| token.as_str().unwrap().to_owned()).collect()
    }
    pub fn destroy(&self) {
      self.window_handler.lock().unwrap().as_ref().unwrap()(&WindowEvent::Destroyed);
    }
    pub fn other_event(&self) {
      self.window_handler.lock().unwrap().as_ref().unwrap()(&WindowEvent::Other);
    }
  }
  pub struct Size { pub width: u32 }
  pub struct Position { pub x: f64, pub y: f64 }
  pub enum DragDropEvent {
    Enter { paths: Vec<std::path::PathBuf>, position: Position },
    Over { position: Position },
    Drop { paths: Vec<std::path::PathBuf>, position: Position },
    Leave,
  }
  pub enum WebviewEvent { DragDrop(DragDropEvent), Other }
  pub enum WindowEvent { Destroyed, DragDrop(DragDropEvent), Other }
  pub trait Emitter {
    fn emit_to(&self, target: &str, event: &str, value: impl serde::Serialize) -> Result<(), String>;
  }
  impl Emitter for WebviewWindow {
    fn emit_to(&self, target: &str, event: &str, value: impl serde::Serialize) -> Result<(), String> {
      self.emitted.lock().unwrap().push((target.into(), event.into(), serde_json::to_value(value).unwrap()));
      Ok(())
    }
  }
  pub mod ipc {
    pub struct Response(pub Vec<u8>);
    impl Response { pub fn new(bytes: Vec<u8>) -> Self { Self(bytes) } }
  }
  pub mod async_runtime {
    pub async fn spawn_blocking<F, R>(f: F) -> Result<R, String>
    where F: FnOnce() -> R + Send + 'static, R: Send + 'static { Ok(f()) }
  }
}
#[path = "drop.rs"]
mod native_drop;
