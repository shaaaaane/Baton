#[tauri::command]
pub async fn macos_new_tab(window: tauri::WebviewWindow) -> Result<String, String> {
  #[cfg(target_os = "macos")]
  {
    let source = window.clone();
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    window.run_on_main_thread(move || {
      use tauri::Manager;
      let result = native::tab_target(&source)
        .and_then(|group| native::build_window(source.app_handle(), Some(&group)));
      let _ = tx.try_send(result);
    }).map_err(|error| error.to_string())?;
    rx.recv().await.ok_or("Tab creation ended without a result")?
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = window;
    Err("Native tabs are only available on macOS".into())
  }
}

#[tauri::command]
pub fn macos_set_tab_title(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  {
    let title: String = title.chars().filter(|c| !c.is_control()).take(220).collect();
    window.set_title(if title.trim().is_empty() { "Baton" } else { &title })
      .map_err(|error| error.to_string())
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = (window, title);
    Err("Native tab titles are only available on macOS".into())
  }
}

#[cfg(target_os = "macos")]
pub mod native {
  use objc2::{rc::Retained, MainThreadMarker};
  use objc2_app_kit::{
    NSApplication, NSWindow, NSWindowTabGroup, NSWindowTabbingMode, NSWindowTitleVisibility,
  };
  use objc2_foundation::NSString;
  use std::sync::atomic::{AtomicUsize, Ordering};
  use tauri::{
    menu::{Menu, MenuItemBuilder, PredefinedMenuItem, WINDOW_SUBMENU_ID},
    Manager, WebviewWindow,
  };

  const TAB_GROUP: &str = "baton-sessions";
  static WINDOW_SEQ: AtomicUsize = AtomicUsize::new(0);

  fn configure_window(window: &WebviewWindow) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("Window setup requires the main thread")?;
    window.set_title_bar_style(tauri::TitleBarStyle::Visible).map_err(|e| e.to_string())?;
    let ptr = window.ns_window().map_err(|e| e.to_string())?;
    // Tauri owns this window. Borrow only on the main thread; do not send NSWindow pointers.
    let native = unsafe { (ptr as *const NSWindow).as_ref() }.ok_or("Missing NSWindow")?;
    native.setTabbingIdentifier(&NSString::from_str(TAB_GROUP));
    native.setTabbingMode(NSWindowTabbingMode::Automatic);
    native.setTitleVisibility(NSWindowTitleVisibility::Visible);
    native.setTitlebarAppearsTransparent(false);
    // Tao disables this when creating windows, so restore it for each new one.
    NSWindow::setAllowsAutomaticWindowTabbing(true, mtm);

    let owner = window.clone();
    window.on_window_event(move |event| {
      if matches!(event, tauri::WindowEvent::Destroyed) {
        // A closed tab cannot run JavaScript teardown. Release only its preview tunnels.
        let owner = owner.clone();
        let app = owner.app_handle().clone();
        tauri::async_runtime::spawn(async move {
          if let Err(error) = crate::preview_proxy::preview_reset(owner, app.state()).await {
            log::warn!("could not release closed window previews: {error}");
          }
        });
      }
    });
    Ok(())
  }

  pub fn tab_target(window: &WebviewWindow) -> Result<Retained<NSWindowTabGroup>, String> {
    let _mtm = MainThreadMarker::new().ok_or("Tab creation requires the main thread")?;
    let ptr = window.ns_window().map_err(|e| e.to_string())?;
    let native = unsafe { (ptr as *const NSWindow).as_ref() }.ok_or("Missing NSWindow")?;
    if native.tabbingIdentifier().to_string() != TAB_GROUP {
      return Err("The source is not a Baton session window".into());
    }
    native.tabGroup().ok_or_else(|| "Native tab group is unavailable".into())
  }

  pub fn build_window(
    app: &tauri::AppHandle,
    group: Option<&NSWindowTabGroup>,
  ) -> Result<String, String> {
    let _mtm = MainThreadMarker::new().ok_or("Window creation requires the main thread")?;
    let n = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("peek-{n}");
    let mut builder = tauri::WebviewWindowBuilder::new(
      app, &label, tauri::WebviewUrl::App("index.html".into()),
    ).title("Baton")
      .min_inner_size(480.0, 400.0)
      .resizable(true)
      .background_color(tauri::webview::Color(0x16, 0x1b, 0x22, 0xff))
      .title_bar_style(tauri::TitleBarStyle::Visible)
      .hidden_title(false)
      .tabbing_identifier(TAB_GROUP)
      .visible(false)
      .focused(false);
    if let Some(group) = group {
      let source = group.selectedWindow().ok_or("Tab group has no selected window")?;
      let size = source.contentRectForFrameRect(source.frame()).size;
      builder = builder.inner_size(size.width, size.height);
    } else {
      let offset = (n % 8) as f64 * 28.0;
      builder = builder.inner_size(1024.0, 768.0).position(120.0 + offset, 120.0 + offset);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    let present = || -> Result<(), String> {
      configure_window(&window)?;
      let ptr = window.ns_window().map_err(|e| e.to_string())?;
      let native = unsafe { (ptr as *const NSWindow).as_ref() }.ok_or("Missing NSWindow")?;
      if let Some(group) = group {
        let source = group.selectedWindow().ok_or("Tab group has no selected window")?;
        // AppKit screen coordinates are logical, bottom-left based. Do not convert through
        // Tauri's physical/top-left window positioning API, including on Retina displays.
        let frame = source.frame();
        native.setFrame_display(frame, false);
        group.addWindow(native);
        if native.frame() != frame { native.setFrame_display(frame, false); }
        group.setSelectedWindow(Some(native));
        native.makeKeyAndOrderFront(None);
      } else {
        // Cmd+N remains an explicit window even when macOS "Prefer tabs" is Always.
        native.setTabbingMode(NSWindowTabbingMode::Disallowed);
        native.makeKeyAndOrderFront(None);
        native.setTabbingMode(NSWindowTabbingMode::Automatic);
      }
      Ok(())
    };
    if let Err(error) = present() {
      let _ = window.close();
      return Err(error);
    }
    Ok(label)
  }

  pub fn spawn(app: &tauri::AppHandle, as_tab: bool) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
      let Some(mtm) = MainThreadMarker::new() else { return };
      let result = if as_tab {
        NSApplication::sharedApplication(mtm).keyWindow()
          .filter(|window| window.tabbingIdentifier().to_string() == TAB_GROUP)
          .and_then(|window| window.tabGroup())
          .ok_or_else(|| "Select a Baton window before opening a tab".to_string())
          .and_then(|group| build_window(&handle, Some(&group)))
      } else {
        build_window(&handle, None)
      };
      if let Err(error) = result { log::warn!("could not create Baton window: {error}"); }
    }) {
      log::warn!("could not schedule Baton window creation: {error}");
    }
  }

  pub fn setup(app: &tauri::App, menu: &Menu<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    for window in app.webview_windows().values() { configure_window(window)?; }
    let file = menu.items()?.into_iter().filter_map(|item| item.as_submenu().cloned())
      .find(|item| item.text().map(|text| text == "File").unwrap_or(false))
      .ok_or("Default File menu is missing")?;
    file.prepend(&MenuItemBuilder::new("New Tab").id("macos_tabs_new")
      .accelerator("Cmd+T").build(app)?)?;
    let window_menu = menu.get(WINDOW_SUBMENU_ID).and_then(|item| item.as_submenu().cloned())
      .ok_or("Default Window menu is missing")?;
    window_menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (id, label, accelerator) in [
      ("macos_tabs_merge", "Merge All Windows", None),
      ("macos_tabs_detach", "Move Tab to New Window", None),
      ("macos_tabs_toggle", "Show/Hide Tab Bar", None),
      ("macos_tabs_next", "Select Next Tab", Some("Cmd+Shift+]")),
      ("macos_tabs_previous", "Select Previous Tab", Some("Cmd+Shift+[")),
    ] {
      let mut item = MenuItemBuilder::new(label).id(id);
      if let Some(shortcut) = accelerator { item = item.accelerator(shortcut); }
      window_menu.append(&item.build(app)?)?;
    }
    Ok(())
  }

  pub fn handle_menu(app: &tauri::AppHandle, id: &str) {
    if id == "macos_tabs_new" { spawn(app, true); return; }
    if !id.starts_with("macos_tabs_") { return; }
    let id = id.to_owned();
    if let Err(error) = app.run_on_main_thread(move || {
      let Some(mtm) = MainThreadMarker::new() else { return };
      let Some(window) = NSApplication::sharedApplication(mtm).keyWindow() else { return };
      if window.tabbingIdentifier().to_string() != TAB_GROUP { return; }
      match id.as_str() {
        "macos_tabs_merge" => window.mergeAllWindows(None),
        "macos_tabs_detach" => window.moveTabToNewWindow(None),
        "macos_tabs_toggle" => window.toggleTabBar(None),
        "macos_tabs_next" => window.selectNextTab(None),
        "macos_tabs_previous" => window.selectPreviousTab(None),
        _ => {}
      }
    }) {
      log::warn!("could not dispatch native tab action: {error}");
    }
  }
}
