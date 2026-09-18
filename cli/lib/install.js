import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { getDownloadUrl, getPlatform } from './platform.js'

const MAX_REDIRECTS = 5

/**
 * Downloads `url` to `filePath`, following up to five redirects. Every way the transfer can
 * fail (a request error, a bad status, a dropped connection, a file error) rejects the promise,
 * and a partial file is removed. `get` is the request function (https.get, or a fake in tests).
 */
export function downloadTo(url, filePath, { onProgress, get = https.get } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false
        const fail = (error) => {
            if (settled) return
            settled = true
            fs.unlink(filePath, () => reject(error))
        }
        const request = (target, redirects) => {
            const req = get(target, (response) => {
                const status = response.statusCode ?? 0
                if (status >= 300 && status < 400 && response.headers.location) {
                    response.resume()
                    if (redirects >= MAX_REDIRECTS) {
                        fail(new Error('Too many redirects'))
                        return
                    }
                    request(new URL(response.headers.location, target).toString(), redirects + 1)
                    return
                }
                if (status !== 200) {
                    response.resume()
                    fail(new Error(`Failed to download: ${status}`))
                    return
                }

                const totalSize = Number.parseInt(response.headers['content-length'] ?? '', 10)
                let downloadedSize = 0
                const file = fs.createWriteStream(filePath)

                response.on('data', (chunk) => {
                    downloadedSize += chunk.length
                    if (onProgress && totalSize) onProgress(downloadedSize, totalSize)
                })
                response.on('error', fail)
                response.on('aborted', () => fail(new Error('Download interrupted')))
                file.on('error', fail)
                file.on('finish', () => {
                    if (settled) return
                    settled = true
                    resolve(filePath)
                })
                response.pipe(file)
            })
            req.on('error', fail)
        }
        request(url, 0)
    })
}

export function download(onProgress) {
    const { url, filename } = getDownloadUrl()
    return downloadTo(url, path.join(os.tmpdir(), filename), { onProgress })
}

export async function install(installerPath) {
    const { isMac, isWindows, isLinux } = getPlatform()
    const { type } = getDownloadUrl()

    if (isMac && type === 'dmg') {
        return installMacDmg(installerPath)
    }

    if (isWindows && type === 'exe') {
        return installWindowsExe(installerPath)
    }

    if (isLinux && type === 'appimage') {
        return installLinuxAppImage(installerPath)
    }

    throw new Error(`Unsupported installer type: ${type}`)
}

async function installMacDmg(dmgPath) {
    // Mount the DMG
    const mountOutput = execSync(`hdiutil attach -nobrowse -readonly "${dmgPath}"`, {
        encoding: 'utf-8',
    })

    // Parse mount point from output
    const mountMatch = mountOutput.match(/\/Volumes\/[^\n]+/)
    if (!mountMatch) {
        throw new Error('Failed to mount DMG')
    }
    const mountPoint = mountMatch[0].trim()

    try {
        // Find the .app in the mounted volume
        const apps = fs.readdirSync(mountPoint).filter((f) => f.endsWith('.app'))
        if (apps.length === 0) {
            throw new Error('No .app found in DMG')
        }

        const appName = apps[0]
        const sourcePath = path.join(mountPoint, appName)
        const destPath = path.join('/Applications', appName)

        // Remove existing installation if present
        if (fs.existsSync(destPath)) {
            fs.rmSync(destPath, { recursive: true, force: true })
        }

        // Copy to Applications
        execSync(`cp -R "${sourcePath}" "/Applications/"`, { encoding: 'utf-8' })
    } finally {
        // Unmount the DMG
        try {
            execSync(`hdiutil detach "${mountPoint}" -quiet`, { encoding: 'utf-8' })
        } catch {
            // Ignore unmount errors
        }
    }
}

async function installWindowsExe(exePath) {
    return new Promise((resolve, reject) => {
        // Run NSIS installer with /S for silent mode
        const child = spawn(exePath, ['/S'], {
            stdio: 'ignore',
            shell: true,
        })

        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) {
                resolve()
            } else {
                reject(new Error(`Installer exited with code ${code}`))
            }
        })
    })
}

async function installLinuxAppImage(appImagePath) {
    const homeDir = os.homedir()
    const binDir = path.join(homeDir, '.local', 'bin')
    const destPath = path.join(binDir, 'rclone-ui')

    // Ensure ~/.local/bin exists
    fs.mkdirSync(binDir, { recursive: true })

    // Copy AppImage to destination
    fs.copyFileSync(appImagePath, destPath)

    // Make executable
    fs.chmodSync(destPath, 0o755)

    // Create .desktop file for application menu
    const desktopDir = path.join(homeDir, '.local', 'share', 'applications')
    fs.mkdirSync(desktopDir, { recursive: true })

    const desktopEntry = `[Desktop Entry]
Name=Rclone UI
Exec=${destPath}
Type=Application
Categories=Utility;
Comment=The GUI for rclone
`

    fs.writeFileSync(path.join(desktopDir, 'rclone-ui.desktop'), desktopEntry)
}
