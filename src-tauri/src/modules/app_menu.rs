use std::io;

use tauri::{
    menu::{Menu, MenuEvent, MenuId, MenuItem},
    AppHandle, Manager, Runtime,
};

const GUARDED_QUIT_MENU_ID: &str = "terax.quit";
const TOGGLE_DEVTOOLS_MENU_ID: &str = "terax.toggle-devtools";
const QUIT_ACCELERATOR: &str = "Command+Q";

fn invalid_default_menu(message: &'static str) -> tauri::Error {
    io::Error::new(io::ErrorKind::InvalidData, message).into()
}

fn is_guarded_quit(id: &MenuId) -> bool {
    id == GUARDED_QUIT_MENU_ID
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let app_menu = menu
        .items()?
        .into_iter()
        .next()
        .and_then(|item| item.as_submenu().cloned())
        .ok_or_else(|| invalid_default_menu("macOS default app menu is missing"))?;
    let items = app_menu.items()?;
    let quit_index = items
        .len()
        .checked_sub(1)
        .ok_or_else(|| invalid_default_menu("macOS default app menu is empty"))?;
    let native_quit = items[quit_index]
        .as_predefined_menuitem()
        .ok_or_else(|| invalid_default_menu("macOS default Quit item is not predefined"))?;
    let quit_text = native_quit.text()?;
    if quit_text != "Quit" && !quit_text.starts_with("Quit ") {
        return Err(invalid_default_menu(
            "macOS default app menu does not end with Quit",
        ));
    }

    // Tear out the native quit so we can rebuild the tail of the menu. The
    // insertion order below matters: positions are 0-based and every insert
    // shifts the items that follow, so always remove first, then re-insert in
    // ascending position order.
    app_menu.remove_at(quit_index)?;

    #[cfg(any(debug_assertions, feature = "devtools"))]
    {
        // A developer menu to open/close the Web Inspector. Release builds
        // only ship it when the devtools feature is on, so normal users never
        // see it. (macOS private API - kept out of the App Store.)
        let toggle_devtools = MenuItem::with_id(
            app,
            TOGGLE_DEVTOOLS_MENU_ID,
            "Toggle Developer Tools",
            true,
            Some("Command+Alt+I"),
        )?;
        app_menu.insert(&toggle_devtools, quit_index)?;
        let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
        app_menu.insert(&separator, quit_index + 1)?;

        let guarded_quit = MenuItem::with_id(
            app,
            GUARDED_QUIT_MENU_ID,
            quit_text,
            true,
            Some(QUIT_ACCELERATOR),
        )?;
        app_menu.insert(&guarded_quit, quit_index + 2)?;
    }

    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    {
        let guarded_quit = MenuItem::with_id(
            app,
            GUARDED_QUIT_MENU_ID,
            quit_text,
            true,
            Some(QUIT_ACCELERATOR),
        )?;
        app_menu.insert(&guarded_quit, quit_index)?;
    }

    Ok(menu)
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    if event.id() == TOGGLE_DEVTOOLS_MENU_ID {
        if let Some(main) = app.get_webview_window("main") {
            if main.is_devtools_open() {
                main.close_devtools();
            } else {
                main.open_devtools();
            }
        }
        return;
    }

    if !is_guarded_quit(event.id()) {
        return;
    }

    let Some(main) = app.get_webview_window("main") else {
        app.exit(0);
        return;
    };

    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    if let Err(error) = main.close() {
        log::error!("could not request guarded app quit: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{is_guarded_quit, GUARDED_QUIT_MENU_ID};
    use tauri::menu::MenuId;

    #[test]
    fn only_guarded_quit_id_requests_window_close() {
        assert!(is_guarded_quit(&MenuId::new(GUARDED_QUIT_MENU_ID)));
        assert!(!is_guarded_quit(&MenuId::new("unrelated")));
    }
}
