import * as Sentry from '@sentry/browser'
import { getVersion as getUiVersion } from '@tauri-apps/api/app'
import { Channel, invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { debug, error, info, trace, warn } from '@tauri-apps/plugin-log'
import { platform } from '@tauri-apps/plugin-os'
import { exit, relaunch } from '@tauri-apps/plugin-process'
import { type Update, check } from '@tauri-apps/plugin-updater'
import pRetry from 'p-retry'
import { defaultOptions } from 'tauri-plugin-sentry-api'
import { type CopyVerifyCoordinator, initCopyVerifyCoordinator } from './lib/copyVerify/coordinator'
import { getDeepLinkUrl, handleDeepLinkUrl } from './lib/deep'
import { CLOSE_APP, RELAUNCH_APP, RESTART_RCLONE, type RestartRclonePayload } from './lib/events'
import { LOCAL_HOST_ID, RC_PORT, getHostInfo, makeLocalHost } from './lib/hosts'
import { validateLicense } from './lib/license'
import {
    clearWatchedJobs,
    dispatchNotification,
    initJobWatcher,
    notify,
    reconcileNotificationTargets,
} from './lib/notifications'
import queryClient from './lib/query'
import { listTransfers, startMount } from './lib/rclone/api'
import rcloneClient from './lib/rclone/client'
import { compareVersions } from './lib/rclone/common'
import { initRclone } from './lib/rclone/init'
import { AutomountSourceError, listMountSource, probeMountSource } from './lib/rclone/mount'
import { reconcileConfigSync } from './lib/rclone/versions'
import { initScheduler } from './lib/scheduler'
import { initTray } from './lib/tray'
import { openSmallWindow } from './lib/window'
import { type RemoteConfig, initHostStore, useHostStore } from './store/host'
import { waitForStoreHydration } from './store/lib'
import { useStore } from './store/memory'
import { selectCurrentHost, usePersistedStore } from './store/persisted'

let rcloneListenersRegistered = false
let copyVerifyCoordinator: CopyVerifyCoordinator | null = null
let mainHostStoreReady = false

usePersistedStore.subscribe((state, previousState) => {
    if (
        !mainHostStoreReady ||
        !state.currentHostId ||
        state.currentHostId === previousState.currentHostId
    )
        return
    switchCopyVerifyHostStore(state.currentHostId).catch((error) =>
        console.error('[main] failed to switch Copy + Verify host store', error)
    )
})

async function switchCopyVerifyHostStore(hostId: string): Promise<void> {
    await copyVerifyCoordinator?.markHostChanged()
    await initHostStore(hostId)
}

// Mirrors zookeeper.rs RcloneEvent — only 'close' is emitted.
type RcloneDaemonEvent = {
    kind: 'close'
    code: number | null
    intentional: boolean
}

async function killRcloneDaemon() {
    // Rust daemon state is authoritative: the command no-ops (returns false) when nothing is
    // tracked, so we must not gate on a local mirror that could defeat its reload-orphan guard.
    let killed = false
    try {
        killed = await invoke<boolean>('kill_rclone_daemon', {})
    } catch (error) {
        console.error('[killRcloneDaemon] failed to kill rclone daemon', error)
        Sentry.captureException(error)
    }
    if (killed) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
}

try {
    Sentry.init({
        ...defaultOptions,
        sendDefaultPii: false,
    })
} catch {
    console.error('Error initializing Sentry')
}

// forward console logs in webviews to the tauri logger, so they show up in terminal
function forwardConsole(
    fnName: 'log' | 'debug' | 'info' | 'warn' | 'error',
    logger: (message: string) => Promise<void>
) {
    try {
        const original = console[fnName]
        console[fnName] = (message, ...args) => {
            original(message, ...args)
            logger(
                `${message} ${args?.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')}`
            )
        }
    } catch {}
}

try {
    forwardConsole('log', trace)
    forwardConsole('debug', debug)
    forwardConsole('info', info)
    forwardConsole('warn', warn)
    forwardConsole('error', error)
} catch (error) {
    console.error('Could not enable console logs', error)
}

async function checkFlatpakPermissions() {
    const hasPermissions = await invoke<boolean>('has_flatpak_permissions')
    if (hasPermissions) return

    const overrideCommand =
        'flatpak override --user --filesystem=host --talk-name=org.freedesktop.Flatpak com.rcloneui.RcloneUI'

    const copyCommand = await ask(
        `You are running the flatpak version of Rclone UI, which is sandboxed.\n\nRclone UI needs disk access to manage your files, and host access to schedule tasks. Please grant both using the following command (copy paste in your terminal):\n\n${overrideCommand}\n\nRestart Rclone UI afterwards.`,
        {
            title: 'Flatpak Permissions Required',
            kind: 'warning',
            okLabel: 'Copy Command & Exit',
            cancelLabel: 'Exit',
        }
    )

    if (copyCommand) {
        await writeText(overrideCommand)
    }

    await exit()
}

async function waitForHydration() {
    console.log('[waitForHydration] waiting for store hydration')
    await waitForStoreHydration(() => usePersistedStore.persist.hasHydrated())
    console.log('[waitForHydration] store hydrated')
}

async function initializeHostStore() {
    console.log('[initializeHostStore] initializing')
    // Default to 'local' if fresh install/no host selected
    const hostId = usePersistedStore.getState().currentHostId || LOCAL_HOST_ID

    await initHostStore(hostId)
    mainHostStoreReady = true

    console.log('[initializeHostStore] initialized for', hostId)
}

async function checkHostReachability(): Promise<void> {
    console.log('[checkHostReachability] checking host reachability')

    const currentHost = selectCurrentHost(usePersistedStore.getState())

    // If no host selected or local host, skip check (local rclone hasn't started yet)
    if (!currentHost || currentHost.id === LOCAL_HOST_ID) {
        console.log('[checkHostReachability] local or no host, skipping')
        return
    }

    console.log('[checkHostReachability] checking remote host:', currentHost.name)

    const checkReachability = async (): Promise<boolean> => {
        try {
            const hostInfo = await getHostInfo({
                id: currentHost.id,
                url: currentHost.url,
                authUser: currentHost.authUser,
                authPassword: currentHost.authPassword,
            })
            return hostInfo !== null
        } catch (err) {
            console.error('[checkHostReachability] error:', err)
            return false
        }
    }

    let isReachable = await checkReachability()

    while (!isReachable) {
        console.log('[checkHostReachability] host not reachable')

        const answer = await ask(
            `The selected host "${currentHost.name}" is not reachable.\n\nURL: ${currentHost.url}\n\nWould you like to retry, switch to local host, or exit?`,
            {
                title: 'Host Not Reachable',
                kind: 'warning',
                okLabel: 'Retry',
                cancelLabel: 'Use Local',
            }
        )

        if (answer) {
            // User chose to retry
            console.log('[checkHostReachability] retrying connection')
            isReachable = await checkReachability()
        } else {
            // User chose to use local host. Upsert the local host and point at it in one write so
            // currentHostId never dangles.
            console.log('[checkHostReachability] switching to local host')
            usePersistedStore.setState((prev) => ({
                hosts: prev.hosts.some((h) => h.id === LOCAL_HOST_ID)
                    ? prev.hosts
                    : [...prev.hosts, makeLocalHost()],
                currentHostId: LOCAL_HOST_ID,
            }))
            // Re-initialize host store for local
            await initHostStore(LOCAL_HOST_ID)
            return
        }
    }

    console.log('[checkHostReachability] host is reachable')
}

async function validateInstance() {
    console.log('[validateInstance] validating license')

    const licenseKey = usePersistedStore.getState().licenseKey
    if (!licenseKey) {
        console.log('[validateInstance] no license key, skipping license validation')
        usePersistedStore.setState({ licenseValid: false })
        return
    }

    if (!navigator.onLine) {
        console.log('[validateInstance] not online, skipping license validation')
        return
    }

    try {
        await validateLicense(licenseKey)
    } catch (e) {
        console.log('[validateInstance] error validating license, marking as invalid')
        usePersistedStore.setState({ licenseValid: false })

        if (e instanceof Error) {
            await message(e.message, {
                title: 'Error Validating License',
                kind: 'error',
                okLabel: 'OK',
            })
            console.log('[validateInstance] error message displayed, returning')
            return
        }

        await message('An error occurred while validating your license. Please try again.', {
            title: 'Error',
            kind: 'error',
            okLabel: 'OK',
        })
        console.log('[validateInstance] default error message displayed, returning')
    } finally {
        console.log('[validateInstance] license validation complete')
    }
}

async function checkAlreadyRunning() {
    console.log('[checkAlreadyRunning]')

    try {
        const running = await invoke<boolean>('is_rclone_running', { port: RC_PORT })
        console.log('[checkAlreadyRunning] running', running)

        if (running) {
            const confirmed = await ask(
                'Rclone is already running on this system.\n\nPlease stop it before launching Rclone UI.',
                {
                    title: 'Rclone Already Running',
                    kind: 'info',
                    okLabel: 'Close Rclone',
                    cancelLabel: 'Exit UI',
                }
            )
            console.log('[checkAlreadyRunning] confirmed', confirmed)

            if (confirmed) {
                console.log('[checkAlreadyRunning] closing rclone')

                if (platform() === 'windows') {
                    console.log('[checkAlreadyRunning] windows, showing message')

                    await message(
                        "If you're on Windows, you might notice a few powershell/terminal dialogs open and close.\n\nThis is normal and expected, imagine we are playing whack-a-mole with the rclone process to close it.",
                        {
                            'title': 'Trigger Warning',
                            'kind': 'info',
                            'okLabel': 'Got it',
                        }
                    )
                }
                const result = await invoke('stop_rclone_processes')
                console.log('[checkAlreadyRunning] stop_rclone_processes', result)
                await new Promise((resolve) => setTimeout(resolve, 700))
            } else {
                console.log('[checkAlreadyRunning] exiting')
                await exit(0)
            }
        }
    } catch (err) {
        console.error('[checkAlreadyRunning] error', err)
        Sentry.captureException(err)
    }
}

async function registerRcloneWindowListeners() {
    if (rcloneListenersRegistered) {
        return
    }

    const window = getCurrentWindow()

    // Kill the daemon BEFORE exit/relaunch — this ordering is the entire point of these listeners.
    const shutdown = async (mode: 'quit' | 'relaunch') => {
        // A dead daemon means "no active transfers": don't let a listTransfers throw make quit a
        // silent no-op.
        const transfers = await queryClient
            .ensureQueryData({
                queryKey: ['transfers', 'list', 'all'],
                queryFn: async () => await listTransfers(),
                staleTime: 10_000, // 10 seconds
                gcTime: 60_000, // 1 minute
            })
            .catch(() => null)

        if (transfers?.active && transfers.active.length > 0) {
            const answer = await ask('All active transfers will be stopped.', {
                title: 'Exit',
                kind: 'info',
                okLabel: mode === 'relaunch' ? 'Relaunch' : 'Quit',
                cancelLabel: 'Cancel',
            })
            if (!answer) {
                return
            }
        }

        const cloudflaredTunnel = useStore.getState().cloudflaredTunnel
        if (cloudflaredTunnel) {
            try {
                console.log('[shutdown] stopping cloudflared tunnel')
                await invoke('stop_cloudflared_tunnel', { pid: cloudflaredTunnel.pid })
                useStore.setState({ cloudflaredTunnel: null })
            } catch (error) {
                console.error('[shutdown] failed to stop cloudflared tunnel', error)
            }
        }

        await killRcloneDaemon()

        if (mode === 'relaunch') {
            await relaunch()
        } else {
            await exit(0)
        }
    }

    await window.listen(CLOSE_APP, async () => {
        console.log('[registerRcloneWindowListeners] close-app requested')
        await shutdown('quit')
    })
    console.log('[registerRcloneWindowListeners] close-app listener registered')

    await window.listen(RELAUNCH_APP, async () => {
        console.log('[registerRcloneWindowListeners] relaunch-app requested')
        await shutdown('relaunch')
    })
    console.log('[registerRcloneWindowListeners] relaunch-app listener registered')

    await window.listen<RestartRclonePayload>(RESTART_RCLONE, async (event) => {
        console.log('[registerRcloneWindowListeners] restart-rclone requested')

        // Trust the payload: the initiating webview's store writes may not have reached the main
        // window yet. Apply BEFORE the in-flight guard so state isn't lost on a skipped restart.
        // configFiles BEFORE activeConfigId (setActiveConfigFile resolves against state.configFiles
        // and nulls on a miss). NEVER log the raw payload — it carries config `pass`.
        const payload = event.payload
        if (payload) {
            if (payload.rclonePath) {
                usePersistedStore.getState().setRclonePath(payload.rclonePath)
            }
            if (payload.defaultConfigPath) {
                useHostStore.getState().setDefaultConfigPath(payload.defaultConfigPath)
            }
            if (payload.configFiles) {
                useHostStore.setState({ configFiles: payload.configFiles })
            }
            if (payload.activeConfigId) {
                useHostStore.getState().setActiveConfigFile(payload.activeConfigId)
            }
            if (payload.proxy !== undefined) {
                useHostStore.setState({ proxy: payload.proxy })
            }
            // Apply BEFORE startRclone so the post-spawn reconcileConfigSync reads fresh intent +
            // ownership marker (a stale marker would let it miss or misattribute the link).
            if (payload.syncConfigToSystem !== undefined) {
                useHostStore.setState({ syncConfigToSystem: payload.syncConfigToSystem })
            }
            if (payload.syncConfigLinkTarget !== undefined) {
                useHostStore.setState({ syncConfigLinkTarget: payload.syncConfigLinkTarget })
            }
        }

        if (useStore.getState().isRestartingRclone) {
            // Don't DROP an overlapping request — that would leave the daemon on the old config while
            // the store/symlink already point at the new one. The payload's state was applied above,
            // so flag a re-run and let the in-flight restart pick it up when it finishes.
            console.log('[restart-rclone] restart in progress, coalescing into a pending re-run')
            useStore.setState({ rcloneRestartPending: true })
            return
        }

        useStore.setState({ isRestartingRclone: true, rcloneRestartPending: false })

        try {
            // Loop so a request that arrived (and applied its state) mid-restart still takes effect.
            do {
                useStore.setState({ rcloneRestartPending: false })
                await copyVerifyCoordinator?.markDaemonRestarted()
                await killRcloneDaemon()

                // Jobids do not survive a daemon restart — polling them would only 404.
                clearWatchedJobs()

                await startRclone()
            } while (useStore.getState().rcloneRestartPending)
        } catch (error) {
            console.error('[restart-rclone] failed to restart rclone', error)
            Sentry.captureException(error)
        } finally {
            useStore.setState({ isRestartingRclone: false })
        }
    })
    console.log('[registerRcloneWindowListeners] restart-rclone listener registered')

    rcloneListenersRegistered = true
}

async function startRclone() {
    console.log('[startRclone]')

    await registerRcloneWindowListeners()

    let rclone: Awaited<ReturnType<typeof initRclone>> | null = null

    try {
        rclone = await initRclone([
            'rcd',
            '--rc-serve',
            '--rc-job-expire-duration',
            '24h',
            '--rc-job-expire-interval',
            '1h',
            // defaults
            // '-rc-addr',
            // ':5572',
        ])
    } catch (error) {
        Sentry.captureException(error)
        await message(
            error instanceof Error
                ? error.message
                : 'Failed to start rclone, please try again later.',
            {
                title: 'Error',
                kind: 'error',
                okLabel: 'Exit',
            }
        )
        return await exit(0)
    }

    if (!rclone) {
        console.error('[startRclone] initRclone returned without a runnable command')
        Sentry.captureException(new Error('initRclone returned without a runnable command.'))
        return
    }

    const { path, args: rcloneArgs, env } = rclone

    const channel = new Channel<RcloneDaemonEvent>()
    channel.onmessage = async (payload) => {
        console.log('[startRclone] daemon close', payload)

        // Killed intentionally (restart / quit) — the initiator handles what happens next.
        if (payload.intentional) {
            return
        }

        // Awaited: the Windows branch below exits the app, so webhook delivery must finish
        // first — but capped so an unreachable endpoint can't stall crash recovery.
        // dispatchNotification never throws. Watched jobids died with the daemon.
        await Promise.race([
            dispatchNotification('rclone.crashed', {
                title: 'Rclone daemon crashed',
                body: `rclone exited unexpectedly${payload.code !== null ? ` (code ${payload.code})` : ''}`,
                data: { exitCode: payload.code },
            }),
            new Promise((resolve) => setTimeout(resolve, 20_000)),
        ])
        clearWatchedJobs()

        if (platform() === 'windows') {
            return await exit(0)
        }

        if (payload.code === 143 || payload.code === 1) {
            Sentry.captureException(new Error('Rclone has crashed'))
            const confirmed = await ask('Rclone has crashed', {
                title: 'Error',
                kind: 'error',
                okLabel: 'Relaunch',
                cancelLabel: 'Exit',
            })
            if (!confirmed) {
                return await exit(0)
            }
            await relaunch()
        }
    }

    console.log('[startRclone] spawning rclone daemon')
    let pid: number
    try {
        pid = await invoke<number>('spawn_rclone', {
            path,
            args: rcloneArgs,
            env,
            onEvent: channel,
        })
    } catch (error) {
        console.error('[startRclone] failed to spawn rclone daemon', error)
        Sentry.captureException(error)
        // A relaunch re-runs the resolution ladder, which can heal a broken binary.
        const confirmed = await ask(
            `Rclone failed to start: ${error instanceof Error ? error.message : String(error)}`,
            {
                title: 'Error',
                kind: 'error',
                okLabel: 'Relaunch',
                cancelLabel: 'Exit',
            }
        )
        if (confirmed) {
            await relaunch()
            return
        }
        return await exit(0)
    }
    console.log('[startRclone] running rclone, pid', pid)

    // Heal the config-sync symlink against the now-settled active config: with intent on, re-point a
    // stale link or recreate one deleted out-of-band; with intent off but a marker still recorded
    // (a disable that crashed before persisting), remove the link we own. A true no-op only when
    // both intent and marker are clear. Marker-proven, so a user's own symlink is never touched.
    await reconcileConfigSync()

    await new Promise((resolve) => setTimeout(resolve, 500))
}

async function startupMounts() {
    console.log('[startupMounts]')

    const remoteConfigList = useHostStore.getState().remoteConfigs

    const remotes = await queryClient.ensureQueryData({
        queryKey: ['remotes', 'list', 'all'],
        queryFn: async () => await rcloneClient('/config/listremotes').then((r) => r?.remotes),
        staleTime: 1000 * 60,
    })
    console.log('[startupMounts] remotes', remotes)

    const jobs: { remote: string; mountOnStart: NonNullable<RemoteConfig['mountOnStart']> }[] = []
    for (const remote of remotes) {
        const remoteConfig = remoteConfigList[remote]
        if (!remoteConfig) {
            console.log('[startupMounts] remote config not found', remote)
            continue
        }
        if (remoteConfig.mountOnStart?.enabled && remoteConfig.mountOnStart?.mountPoint) {
            console.log('[startupMounts] automount enabled', remote, remoteConfig.mountOnStart)
            jobs.push({ remote, mountOnStart: remoteConfig.mountOnStart })
        }
    }
    if (jobs.length === 0) {
        return
    }

    const runJobs = async () => {
        for (const { remote, mountOnStart } of jobs) {
            const {
                mountPoint,
                remotePath,
                mountOptions,
                vfsOptions,
                filterOptions,
                configOptions,
            } = mountOnStart
            const source = `${remote}:${remotePath}`

            try {
                await pRetry(() => probeMountSource(source), {
                    retries: 7,
                    factor: 2,
                    minTimeout: 1_000,
                    maxTimeout: 15_000,
                    shouldRetry: ({ error }: { error: unknown }) =>
                        !(error instanceof AutomountSourceError),
                })
            } catch (error) {
                console.error('[startupMounts] source probe failed, not mounting', source, error)
                const body =
                    error instanceof AutomountSourceError
                        ? error.message
                        : `${source} is not reachable (network or sign-in problem) — not mounting to avoid an empty folder at ${mountPoint}`
                dispatchNotification('mount.failed', {
                    title: 'Automount skipped',
                    body,
                    data: {
                        source,
                        destination: mountPoint,
                        error: error instanceof Error ? error.message : String(error),
                    },
                })
                await notify({ title: 'Automount skipped', body })
                continue
            }

            try {
                console.log('[startupMounts] starting mount', {
                    source,
                    destination: mountPoint,
                })
                await startMount({
                    source,
                    destination: mountPoint,
                    options: {
                        mount: mountOptions,
                        vfs: vfsOptions,
                        filter: filterOptions,
                        config: configOptions,
                    },
                })
                console.log('[startupMounts] mount started')
                try {
                    await listMountSource(source)
                } catch (error) {
                    console.warn('[startupMounts] mounted but listing failed', source, error)
                    await notify({
                        title: 'Automount warning',
                        body: `${source} mounted at ${mountPoint}, but listing it failed — the folder may appear empty until the connection recovers`,
                    })
                }
            } catch (error) {
                console.error('Error mounting remote:', error)
                Sentry.captureException(error)
                await notify({
                    title: 'Automount Error',
                    body:
                        error instanceof Error
                            ? error.message
                            : `Failed to mount ${remote} on startup.`,
                })
            }
        }
    }
    runJobs().catch((error) => console.error('[startupMounts] unexpected failure', error))
}

async function showStartup() {
    console.log('[showStartup] showing startup')
    const hideStartup = usePersistedStore.getState().hideStartup
    if (hideStartup) {
        console.log('[showStartup] startup hidden, returning')
        return
    }

    const startupDisplayed = useStore.getState().startupDisplayed
    if (startupDisplayed) {
        console.log('[showStartup] startup already displayed, returning')
        return
    }

    console.log('[showStartup] startup not displayed, setting displayed and status')
    // Upgrade-only: a successful auto-update's 'updated' status must survive so its message shows;
    // everything else (normal launch with null status, or a failed update restored to
    // 'initializing') becomes 'initialized'. Never unconditionally clobber, or 'updated' is lost.
    const currentStartupStatus = useStore.getState().startupStatus
    useStore.setState({
        startupDisplayed: true,
        startupStatus: currentStartupStatus === 'updated' ? 'updated' : 'initialized',
    })
    console.log('[showStartup] store updated with startup displayed and status set')
    await openSmallWindow({
        name: 'Startup',
        url: '/startup',
    })
    console.log('[showStartup] startup window opened')
    if (!['windows', 'macos'].includes(platform())) {
        usePersistedStore.setState({ hideStartup: true })
    }
    console.log('[showStartup] startup hidden')
}

async function installUpdate(update: Update, required: boolean) {
    const confirmed = await ask(
        'You are running an outdated version of Rclone UI. Please update to the latest version.',
        {
            title: required ? 'Update Required' : 'Update Available',
            kind: 'info',
            okLabel: 'Update',
            cancelLabel: required ? 'Exit' : 'Cancel',
        }
    )

    if (!confirmed) {
        console.log('[checkVersion] user cancelled update')
        if (required) {
            return await exit(0)
        }
        return
    }

    if (await invoke<boolean>('is_flatpak')) {
        console.log('[checkVersion] flatpak detected, skipping update')

        await message(
            'A Flatpak version cannot update itself. Please update Rclone UI through your software manager.',
            {
                title: required ? 'Update Required' : 'Update Available',
                kind: 'info',
                okLabel: required ? 'Exit' : 'OK',
            }
        )

        if (required) {
            return await exit(0)
        }

        return
    }

    console.log('[checkVersion] downloading and installing update')

    await update.downloadAndInstall()

    console.log('[checkVersion] update downloaded and installed')

    await message('Rclone UI has been updated. Please restart the application.', {
        title: 'Update Complete',
        kind: 'info',
        okLabel: 'Restart',
    })

    console.log('[checkVersion] relaunching app')

    // Direct relaunch: at checkVersion time no daemon exists yet (before startRclone), so the
    // shutdown path is unnecessary; the old emit fired before any listener existed and was
    // dropped, leaving the app running the old version.
    await relaunch()
}

async function checkVersion() {
    console.log('[checkVersion]')

    try {
        console.log('[checkVersion] fetching meta.json')

        const latestMeta = await fetch('https://rcloneui.com/latest')
        console.log('[checkVersion] meta.json fetched')

        const latestMetaData = (await latestMeta.json()) as {
            minimumVersion: string
            okVersion: string
        }
        console.log('[checkVersion] meta.json parsed')

        const { minimumVersion, okVersion } = latestMetaData

        console.log('[checkVersion] minimumVersion', minimumVersion)
        console.log('[checkVersion] okVersion', okVersion)

        const currentVersion = await getUiVersion()
        console.log('[checkVersion] currentVersion', currentVersion)

        if (
            compareVersions(currentVersion, minimumVersion) >= 0 &&
            compareVersions(currentVersion, okVersion) >= 0
        ) {
            console.log('[checkVersion] currentVersion is up to date')
            return
        }

        console.log('[checkVersion] checking for update')

        const receivedUpdate = await check({
            allowDowngrades: true,
            timeout: 30000,
        })

        console.log('[checkVersion] update check complete')

        if (!receivedUpdate) {
            console.log('[checkVersion] no update found')
            return
        }

        dispatchNotification('app.update-available', {
            title: 'Rclone UI update available',
            body: `Version ${receivedUpdate.version} is available (current: ${currentVersion})`,
            data: {
                currentVersion,
                latestVersion: receivedUpdate.version,
                minimumVersion,
                okVersion,
            },
        })

        if (compareVersions(currentVersion, minimumVersion) < 0) {
            console.log('[checkVersion] currentVersion is outdated')
            await installUpdate(receivedUpdate, true)
        } else if (compareVersions(currentVersion, okVersion) < 0) {
            console.log('[checkVersion] checking for update')
            await installUpdate(receivedUpdate, false)
        }
    } catch (error) {
        console.error('[checkVersion] error', error)
        Sentry.captureException(error)
    }
}

async function checkRclone() {
    let currentHost = selectCurrentHost(usePersistedStore.getState()) ?? makeLocalHost()

    let hostInfo = await getHostInfo({
        id: currentHost.id,
        url: currentHost.url,
        authUser: currentHost.authUser,
        authPassword: currentHost.authPassword,
    })

    if (!hostInfo) {
        await message(
            'Failed to get host info, is it online and reachable?\n\nSwitching to local host.',
            {
                title: 'Host Not Reachable',
                kind: 'error',
            }
        )
        currentHost = makeLocalHost()

        hostInfo = await getHostInfo({
            id: currentHost.id,
            url: currentHost.url,
            authUser: currentHost.authUser,
            authPassword: currentHost.authPassword,
        })

        if (!hostInfo) {
            const confirmed = await ask(
                'Local host is not reachable, please try again or file an issue on Github if the problem persists.',
                {
                    title: 'Local Host Not Reachable',
                    kind: 'error',
                    okLabel: 'Exit',
                }
            )

            if (confirmed) {
                return await exit(0)
            }

            await new Promise((resolve) => setTimeout(resolve, 60_000))
            return await exit(0)
        }
    }

    currentHost = {
        ...currentHost,
        os: hostInfo.os,
        cliVersion: hostInfo.cliVersion,
    }

    console.log('[checkRclone] setting currentHost', currentHost)

    usePersistedStore.setState((prev) => ({
        hosts: [...prev.hosts.filter((h) => h.id !== currentHost.id), currentHost],
        currentHostId: currentHost.id,
    }))
}

getCurrentWindow().listen('tauri://close-requested', async () => {
    console.log('(main) window close requested')
    await getCurrentWindow().destroy()
})

function processDeepLink(url: string) {
    const deepLinkUrl = getDeepLinkUrl(url)
    console.log('deep link url', deepLinkUrl)
    handleDeepLinkUrl(deepLinkUrl)
    useStore.setState({ startupDisplayed: true, startupStatus: 'initializing' })
}

onOpenUrl((urls) => {
    console.log('deep links while running', urls)
    processDeepLink(urls[0])
})

async function handleDeepLink() {
    console.log('[handleDeepLink] getting current deep links')
    const urls = await getCurrent()
    if (!urls || urls.length === 0) {
        console.log('[handleDeepLink] no deep links found')
        return
    }
    processDeepLink(urls[0])
}

waitForHydration()
    .then(() => checkFlatpakPermissions())
    .then(() => initializeHostStore())
    .then(() => checkHostReachability())
    .then(() => registerRcloneWindowListeners())
    .then(() => checkVersion())
    .then(() => validateInstance())
    .then(() => checkAlreadyRunning())
    .then(() => startRclone())
    .then(() => checkRclone())
    .then(async () => {
        copyVerifyCoordinator = await initCopyVerifyCoordinator()
    })
    .then(() => reconcileNotificationTargets())
    .then(() => initJobWatcher())
    .then(() => handleDeepLink())
    .then(() => showStartup())
    .then(() => startupMounts())
    .then(() => initScheduler())
    .then(() => initTray())
    .catch(console.error)
