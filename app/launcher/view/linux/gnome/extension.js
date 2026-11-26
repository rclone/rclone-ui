import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const TITLE = 'Rclone UI Launcher';
const APP_IDS = ['org.rclone.ui'];
const WIDTH = 700;
const FULL_HEIGHT = 478;

export default class RcloneUILauncher extends Extension {
    enable() {
        this._dragged = null;
        this._waiting = new Map();
        this._handlers = [
            global.display.connect('window-created', (_display, window) => this._created(window)),
            global.display.connect('grab-op-end', (_display, window) => this._moved(window)),
        ];
    }

    disable() {
        for (const id of this._handlers)
            global.display.disconnect(id);
        for (const actor of [...this._waiting.keys()])
            this._forget(actor);
        this._handlers = [];
        this._dragged = null;
    }

    // Reports whether a window is the launcher. It must have the launcher's title and come from
    // Rclone UI, according to its GTK application id. The view sets the app's id on the window,
    // as GtkApplication does for the app's other windows. Any client can claim any id, but a
    // sandboxed client (Flatpak, Snap) can't hide its sandbox's id. So a sandboxed window only
    // counts when its sandbox id matches the id it claims. This stops another sandboxed app from
    // taking the launcher's place above other windows and getting focus.
    _ours(window) {
        if (!window || window.get_title() !== TITLE)
            return false;
        const id = window.get_gtk_application_id();
        if (!APP_IDS.includes(id))
            return false;
        const sandboxed = window.get_sandboxed_app_id();
        return !sandboxed || sandboxed === id;
    }

    // Each Show creates a new window, because GTK unmaps it on Hide. The window is identified and
    // placed at its first frame. By then the client has set its title and application id, which a
    // Wayland window may not have when it is created, and the window has its size. GNOME's
    // opening animation starts the window transparent, so its first position isn't visible.
    _created(window) {
        const actor = window.get_compositor_private();
        if (!actor) {
            if (this._ours(window))
                this._place(window);
            return;
        }
        this._waiting.set(actor, [
            actor.connect('first-frame', () => {
                this._forget(actor);
                if (this._ours(window))
                    this._place(window);
            }),
            actor.connect('destroy', () => this._forget(actor)),
        ]);
    }

    _forget(actor) {
        const ids = this._waiting.get(actor);
        if (!ids)
            return;
        this._waiting.delete(actor);
        for (const id of ids)
            actor.disconnect(id);
    }

    _place(window) {
        const frame = window.get_frame_rect();
        const scale = frame.width > 0 ? frame.width / WIDTH : 1;
        let x, y;
        if (this._dragged && this._dragged.monitor < global.display.get_n_monitors()) {
            const area = Main.layoutManager.getWorkAreaForMonitor(this._dragged.monitor);
            x = area.x + this._dragged.x;
            y = area.y + this._dragged.y;
        } else {
            const area = Main.layoutManager.getWorkAreaForMonitor(global.display.get_current_monitor());
            x = area.x + Math.round((area.width - frame.width) / 2);
            y = area.y + Math.max(0, Math.round((area.height - FULL_HEIGHT * scale) / 2));
        }
        window.move_frame(true, x, y);
        window.make_above();
        window.stick();
        Main.activateWindow(window);
    }

    _moved(window) {
        if (!this._ours(window))
            return;
        const monitor = window.get_monitor();
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);
        const frame = window.get_frame_rect();
        this._dragged = {monitor, x: frame.x - area.x, y: frame.y - area.y};
    }
}
