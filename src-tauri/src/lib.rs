// Multi-window is macOS-only. Windows/Linux are intentionally left single-window
// (title_bar_style/hidden_title below are macOS-only builder methods anyway).
mod preview_proxy;
mod macos_tabs;

#[tauri::command]
fn ios_build_number() -> Option<String> {
  #[cfg(target_os = "ios")]
  {
    use objc2_foundation::{ns_string, NSBundle, NSString};

    let build_number = NSBundle::mainBundle()
      .objectForInfoDictionaryKey(ns_string!("CFBundleVersion"))?
      .downcast::<NSString>()
      .ok()?;

    Some(build_number.to_string())
  }

  #[cfg(not(target_os = "ios"))]
  {
    None
  }
}

// Cmd+N remains a separate WebView window; Cmd+T explicitly joins the current native group.
#[cfg(target_os = "macos")]
fn spawn_peek_window(app: &tauri::AppHandle) {
  macos_tabs::native::spawn(app, false);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_in_app_browser::init())
    .plugin(tauri_plugin_file_download::init())
    .plugin(tauri_plugin_preview_webview::init())
    .plugin(tauri::plugin::Builder::<_, ()>::new("browser-frame")
      .js_init_script_on_all_frames(include_str!("../../web/js/browser/frame-bridge.js"))
      .build())
    .manage(std::sync::Arc::new(preview_proxy::PreviewProxy::default()))
    .invoke_handler(tauri::generate_handler![
      ios_build_number,
      macos_tabs::macos_new_tab,
      macos_tabs::macos_set_tab_title,
      preview_proxy::preview_start,
      preview_proxy::preview_credit,
      preview_proxy::preview_write,
      preview_proxy::preview_shutdown_write,
      preview_proxy::preview_close_socket,
      preview_proxy::preview_stop,
      preview_proxy::preview_reset
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      #[cfg(any(target_os = "android", target_os = "ios"))]
      app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
      #[cfg(any(target_os = "android", target_os = "ios"))]
      app.handle().plugin(tauri_plugin_clipboard_manager::init())?;
      #[cfg(target_os = "ios")]
      app.handle().plugin(tauri_plugin_speech::init())?;

      // macOS menu: start from the standard system menu (Menu::default wires up
      // the Edit submenu, so ⌘X/⌘C/⌘V reach the WebView), then inject ⌘N
      // (New Window) at the top of the File submenu. Building the menu by hand
      // would drop those predefined Edit items and break paste.
      #[cfg(target_os = "macos")]
      {
        use tauri::menu::{Menu, MenuItemBuilder};

        let menu = Menu::default(app.handle())?;

        let new_window = MenuItemBuilder::new("New Window")
          .id("new_window")
          .accelerator("Cmd+N")
          .build(app)?;

        // File is the submenu right after the app-name submenu.
        if let Some(file) = menu
          .items()?
          .iter()
          .filter_map(|i| i.as_submenu())
          .find(|s| s.text().map(|t| t == "File").unwrap_or(false))
        {
          file.prepend(&new_window)?;
        }

        macos_tabs::native::setup(app, &menu)?;
        app.set_menu(menu)?;
        app.on_menu_event(|app, event| {
          if event.id() == "new_window" {
            spawn_peek_window(app);
          }
          macos_tabs::native::handle_menu(app, event.id().as_ref());
        });
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
