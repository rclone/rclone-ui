import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { defineConfig } from '@playwright/test'
import { SERVER_BIN } from './e2e/helpers'

// Browser-mode smoke tests against a real rclone-cloud (debug binary, so `npm run build`'s
// frontend/dist/ is read from disk) and a real rclone daemon. Two servers: one open on loopback, one
// password-protected. `npm run test:e2e`.
const tmp = new URL('./e2e/.tmp/', import.meta.url).pathname
// Fresh state every run: the lifecycle persists what it adopts (the binary, the owner account).
// Only the main process resets it — workers re-import this file after the servers are already
// running.
if (!process.env.TEST_WORKER_INDEX) {
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(`${tmp}open`, { recursive: true })
    mkdirSync(`${tmp}auth`, { recursive: true })
    mkdirSync(`${tmp}managed`, { recursive: true })
    writeFileSync(`${tmp}rclone.conf`, '[e2e-memory]\ntype = memory\n')
}

// The external-daemon servers point at the shared `rclone rcd`; the managed one spawns its own.
const external = '--rclone-url http://localhost:5572'
// Every server needs a password; it becomes the owner account (admin@localhost) on first start.
const password = '--password e2e-secret'

export default defineConfig({
    testDir: 'e2e',
    // Pure-function snapshots (the request builders) are the same on every platform.
    snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{ext}',
    timeout: 60_000,
    retries: 0,
    // The specs share the three servers' state (settings password, the memory remote), so they
    // run one at a time.
    workers: 1,
    use: { baseURL: 'http://127.0.0.1:5610' },
    // The setup project signs the owner into the default server once; every test's `page` and
    // `request` then start from that cookie. Tests on the other servers sign in themselves.
    projects: [
        { name: 'setup', testMatch: /auth\.setup\.ts/ },
        {
            name: 'e2e',
            dependencies: ['setup'],
            testIgnore: /auth\.setup\.ts/,
            use: { storageState: `${tmp}storage.json` },
        },
    ],
    webServer: [
        {
            command: `rclone rcd --rc-no-auth --rc-serve --rc-addr localhost:5572 --config ${tmp}rclone.conf`,
            port: 5572,
            reuseExistingServer: true,
            timeout: 20_000,
        },
        {
            command: `${SERVER_BIN} serve --bind 127.0.0.1:5610 ${password} ${external} --data-dir ${tmp}open`,
            url: 'http://127.0.0.1:5610/api/session',
            reuseExistingServer: false,
            timeout: 20_000,
        },
        {
            command: `${SERVER_BIN} serve --bind 127.0.0.1:5611 ${password} ${external} --data-dir ${tmp}auth`,
            url: 'http://127.0.0.1:5611/api/session',
            reuseExistingServer: false,
            timeout: 20_000,
        },
        {
            command: `${SERVER_BIN} serve --bind 127.0.0.1:5612 ${password} --rclone-path /usr/local/bin/rclone --data-dir ${tmp}managed`,
            url: 'http://127.0.0.1:5612/api/status',
            reuseExistingServer: false,
            timeout: 20_000,
            // Keeps the managed daemon hermetic. The server sets nothing about rclone's config;
            // the daemon inherits this environment, so RCLONE_CONFIG is what points it at the
            // suite's file instead of the developer's ~/.config/rclone/rclone.conf.
            env: { RCLONE_CONFIG: `${tmp}rclone.conf` },
        },
    ],
})
