import { spawn } from "node:child_process";
import { getPlatform } from "./platform.js";
import { getInstallPath } from "./detect.js";

export function openApp() {
    const { isMac, isWindows, isLinux } = getPlatform();
    const installPath = getInstallPath();

    return new Promise((resolve, reject) => {
        let child;

        if (isMac) {
            child = spawn("open", ["-a", "Rclone UI"], {
                detached: true,
                stdio: "ignore",
            });
        } else if (isWindows) {
            child = spawn(installPath, [], {
                detached: true,
                stdio: "ignore",
                shell: true,
            });
        } else if (isLinux) {
            child = spawn(installPath, [], {
                detached: true,
                stdio: "ignore",
            });
        } else {
            reject(new Error("Unsupported platform"));
            return;
        }

        settleLaunch(child, resolve, reject);
    });
}

/**
 * A launcher that fails does so at once: an `error` (nothing to run) or an early non-zero exit
 * rejects. One that is still running after the grace period is the app itself, and resolves.
 */
export function settleLaunch(child, resolve, reject, graceMs = 500) {
    let settled = false;
    const done = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
    };
    child.unref();
    child.on("error", (error) => done(reject, error));
    child.on("exit", (code) => {
        if (code !== 0 && code !== null) {
            done(reject, new Error(`The launcher exited with code ${code}`));
        }
    });
    setTimeout(() => done(resolve), graceMs).unref?.();
}

