import { captureException } from '@sentry/browser'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { reportError } from '../lib/errors'
import { CLOSE_APP, emitToMain } from '../lib/events'
import { notify } from '../lib/notifications'
import queryClient from '../lib/query'
import type { fetchMountList, fetchServeList } from '../lib/rclone/api'
import rclone from '../lib/rclone/client'
import { SERVE_TYPES } from '../lib/rclone/constants'
import { openFullWindow } from '../lib/window'
import { usePersistedStore } from '../store/persisted'
import { COMMAND_CONFIG, COMMAND_DESCRIPTIONS, COMMAND_KEYWORDS } from './constants'
import type {
    ToolbarActionArgs,
    ToolbarActionDefinition,
    ToolbarActionOnPressContext,
    ToolbarActionPath,
    ToolbarActionResult,
    ToolbarCommandId,
} from './types'
import { formatMountLabel, formatServeInfo, formatServeLabel } from './utils'

const WHITESPACE_SPLIT = /\s+/
const TOKEN_TRIM_REGEX = /^[\"'`]+|[\"'`.,;!?]+$/g
const SIMPLE_URL_REGEX = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}([/:?][^\s]*)?$/
const TRAILING_SLASH_REGEX = /\/+$/

const actions: ToolbarActionDefinition[] = [
    {
        id: 'copy',
        label: 'Copy',
        description: COMMAND_DESCRIPTIONS.copy,
        keywords: COMMAND_KEYWORDS.copy,
        getDefaultResult: () => createBaseResult('Copy', COMMAND_DESCRIPTIONS.copy, {}, 50),
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.copy)) {
                return []
            }

            if (paths.length === 0) {
                return [createBaseResult('Copy', COMMAND_DESCRIPTIONS.copy, {}, 50)]
            }

            const results: ToolbarActionResult[] = []

            if (paths.length === 2) {
                const [source, destination] = paths
                results.push(
                    createBaseResult(
                        `Copy ${source.readable} → ${destination.readable}`,
                        COMMAND_DESCRIPTIONS.copy,
                        {
                            initialSource: normalizePathForArgs(source),
                            initialDestination: normalizePathForArgs(destination),
                        },
                        200
                    )
                )
            }

            for (let index = 0; index < paths.length; index += 1) {
                const path = paths[index]
                const isDestination = paths.length > 1 && index === paths.length - 1
                const args: ToolbarActionArgs = isDestination
                    ? { initialDestination: normalizePathForArgs(path) }
                    : { initialSource: normalizePathForArgs(path) }
                const score = path.isLocal ? 140 : isDestination ? 155 : 160

                results.push(
                    createBaseResult(
                        `Copy ${path.readable}`,
                        COMMAND_DESCRIPTIONS.copy,
                        args,
                        score
                    )
                )
            }

            return results
        },
        onPress: async (args, context) => {
            await openCommandWindow('copy', args, context)
        },
    },
    {
        id: 'move',
        label: 'Move',
        description: COMMAND_DESCRIPTIONS.move,
        keywords: COMMAND_KEYWORDS.move,
        getDefaultResult: () => createBaseResult('Move', COMMAND_DESCRIPTIONS.move, {}, 48),
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.move)) {
                return []
            }

            if (paths.length === 0) {
                return [createBaseResult('Move', COMMAND_DESCRIPTIONS.move, {}, 48)]
            }

            const results: ToolbarActionResult[] = []

            if (paths.length === 2) {
                const [source, destination] = paths
                results.push(
                    createBaseResult(
                        `Move ${source.readable} → ${destination.readable}`,
                        COMMAND_DESCRIPTIONS.move,
                        {
                            initialSource: normalizePathForArgs(source),
                            initialDestination: normalizePathForArgs(destination),
                        },
                        200
                    )
                )
            }

            for (let index = 0; index < paths.length; index += 1) {
                const path = paths[index]
                const isDestination = paths.length > 1 && index === paths.length - 1
                const args: ToolbarActionArgs = isDestination
                    ? { initialDestination: normalizePathForArgs(path) }
                    : { initialSource: normalizePathForArgs(path) }
                const score = path.isLocal ? 140 : isDestination ? 155 : 160

                results.push(
                    createBaseResult(
                        `Move ${path.readable}`,
                        COMMAND_DESCRIPTIONS.move,
                        args,
                        score
                    )
                )
            }

            return results
        },
        onPress: async (args, context) => {
            await openCommandWindow('move', args, context)
        },
    },
    {
        id: 'sync',
        label: 'Sync',
        description: COMMAND_DESCRIPTIONS.sync,
        keywords: COMMAND_KEYWORDS.sync,
        getDefaultResult: () => createBaseResult('Sync', COMMAND_DESCRIPTIONS.sync, {}, 46),
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.sync)) {
                return []
            }

            if (paths.length === 0) {
                return [createBaseResult('Sync', COMMAND_DESCRIPTIONS.sync, {}, 46)]
            }

            const results: ToolbarActionResult[] = []

            if (paths.length === 2) {
                const [source, destination] = paths
                results.push(
                    createBaseResult(
                        `Sync ${source.readable} ↔ ${destination.readable}`,
                        COMMAND_DESCRIPTIONS.sync,
                        {
                            initialSource: normalizePathForArgs(source),
                            initialDestination: normalizePathForArgs(destination),
                        },
                        200
                    )
                )
            }

            for (let index = 0; index < paths.length; index += 1) {
                const path = paths[index]
                const isDestination = paths.length > 1 && index === paths.length - 1
                const args: ToolbarActionArgs = isDestination
                    ? { initialDestination: normalizePathForArgs(path) }
                    : { initialSource: normalizePathForArgs(path) }
                const score = path.isLocal ? 140 : isDestination ? 155 : 160

                results.push(
                    createBaseResult(
                        `Sync ${path.readable}`,
                        COMMAND_DESCRIPTIONS.sync,
                        args,
                        score
                    )
                )
            }

            return results
        },
        onPress: async (args, context) => {
            await openCommandWindow('sync', args, context)
        },
    },
    {
        id: 'bisync',
        label: 'Bisync',
        description: COMMAND_DESCRIPTIONS.bisync,
        keywords: COMMAND_KEYWORDS.bisync,
        getDefaultResult: () => createBaseResult('Bisync', COMMAND_DESCRIPTIONS.bisync, {}, 44),
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.bisync)) {
                return []
            }

            if (paths.length === 0) {
                return [createBaseResult('Bisync', COMMAND_DESCRIPTIONS.bisync, {}, 44)]
            }

            const results: ToolbarActionResult[] = []

            if (paths.length === 2) {
                const [source, destination] = paths
                results.push(
                    createBaseResult(
                        `Bisync ${source.readable} ↔ ${destination.readable}`,
                        COMMAND_DESCRIPTIONS.bisync,
                        {
                            initialSource: normalizePathForArgs(source),
                            initialDestination: normalizePathForArgs(destination),
                        },
                        200
                    )
                )
            }

            for (let index = 0; index < paths.length; index += 1) {
                const path = paths[index]
                const isDestination = paths.length > 1 && index === paths.length - 1
                const args: ToolbarActionArgs = isDestination
                    ? { initialDestination: normalizePathForArgs(path) }
                    : { initialSource: normalizePathForArgs(path) }
                const score = path.isLocal ? 140 : isDestination ? 155 : 160

                results.push(
                    createBaseResult(
                        `Bisync ${path.readable}`,
                        COMMAND_DESCRIPTIONS.bisync,
                        args,
                        score
                    )
                )
            }

            return results
        },
        onPress: async (args, context) => {
            await openCommandWindow('bisync', args, context)
        },
    },
    {
        id: 'mount',
        label: 'Mount',
        description: COMMAND_DESCRIPTIONS.mount,
        keywords: COMMAND_KEYWORDS.mount,
        getDefaultResult: () => createBaseResult('Mount', COMMAND_DESCRIPTIONS.mount, {}, 42),
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.mount)) {
                return []
            }

            const results: ToolbarActionResult[] = []

            const activeMounts = queryClient.getQueryData(['mount', 'list']) as
                | Awaited<ReturnType<typeof fetchMountList>>
                | undefined

            if (activeMounts && activeMounts.length > 0) {
                for (const mount of activeMounts) {
                    const mountLabel = formatMountLabel(mount)

                    if (usePersistedStore.getState().currentHostId === 'local') {
                        results.push(
                            createBaseResult(
                                `Open ${mountLabel}`,
                                'Open mount point in file explorer',
                                { _action: 'open', _mountPoint: mount.MountPoint },
                                180
                            )
                        )
                    } else {
                        results.push(
                            createBaseResult(
                                `Copy ${mountLabel}`,
                                'Press Enter to copy mount details to clipboard',
                                { _action: 'copy_info', _mountPoint: mount.MountPoint },
                                180
                            )
                        )
                    }

                    results.push(
                        createBaseResult(
                            `Stop ${mountLabel}`,
                            'Unmount this path',
                            { _action: 'stop', _mountPoint: mount.MountPoint },
                            175
                        )
                    )
                }

                if (activeMounts.length >= 2) {
                    results.push(
                        createBaseResult(
                            `Stop All Mounts (${activeMounts.length} active)`,
                            'Unmount all active mounts',
                            { _action: 'stop_all' },
                            170
                        )
                    )
                }
            }

            const queryIsOnlyKeyword =
                !query ||
                (matchesKeyword(query, COMMAND_KEYWORDS.mount) &&
                    query.trim().split(/\s+/).length <= 1)

            if (paths.length === 0 || queryIsOnlyKeyword) {
                results.push(createBaseResult('Mount', COMMAND_DESCRIPTIONS.mount, {}, 42))
            } else {
                for (const path of paths.slice(0, 40)) {
                    const score = path.isLocal ? 140 : 160
                    results.push(
                        createBaseResult(
                            `Mount ${path.readable}`,
                            COMMAND_DESCRIPTIONS.mount,
                            { initialSource: normalizePathForArgs(path) },
                            score
                        )
                    )
                }
            }

            return results
        },
        onPress: async (args, context) => {
            if (args._action === 'open') {
                const mountPoint = args._mountPoint as string
                try {
                    await revealItemInDir(mountPoint)
                } catch (error) {
                    await reportError(error, {
                        title: 'Open Mount',
                        fallback: 'Failed to open mount point',
                        capture: false,
                        log: ['[toolbar] failed to open mount'],
                    })
                }
                return
            }

            if (args._action === 'copy_info') {
                const mountPoint = args._mountPoint as string
                await writeText(mountPoint)
                await notify({
                    title: 'Copied!',
                    body: 'Mount point copied to clipboard',
                })
                return
            }

            if (args._action === 'stop') {
                const mountPoint = args._mountPoint as string

                const confirmed = await ask('Are you sure you want to unmount this path?', {
                    title: 'Confirm Unmount',
                    kind: 'warning',
                })

                if (!confirmed) {
                    return
                }

                try {
                    await rclone('/mount/unmount', {
                        params: {
                            query: {
                                mountPoint: mountPoint,
                            },
                        },
                    })
                    await notify({
                        title: 'Mount Stopped',
                        body: `Mount point ${mountPoint} has been unmounted`,
                    })
                    queryClient.setQueryData(
                        ['mount', 'list'],
                        (old: Awaited<ReturnType<typeof fetchMountList>> | undefined) =>
                            old?.filter((m) => m.MountPoint !== mountPoint) ?? []
                    )
                } catch (error) {
                    await reportError(error, {
                        title: 'Stop Mount',
                        fallback: 'Failed to stop mount instance',
                        capture: false,
                        log: ['[toolbar] failed to stop mount'],
                    })
                    await queryClient.resetQueries({ queryKey: ['mount', 'list'] })
                }
                return
            }

            if (args._action === 'stop_all') {
                const confirmed = await ask('Are you sure you want to unmount ALL paths?', {
                    title: 'Confirm Stop All',
                    kind: 'warning',
                })

                if (!confirmed) {
                    return
                }

                try {
                    await rclone('/mount/unmountall')
                    await notify({
                        title: 'All Mounts Stopped',
                        body: 'All mount instances have been unmounted',
                    })
                    queryClient.setQueryData(['mount', 'list'], [])
                } catch (error) {
                    await reportError(error, {
                        title: 'Stop All Mounts',
                        fallback: 'Failed to stop all mount instances',
                        capture: false,
                        log: ['[toolbar] failed to stop all mounts'],
                    })
                    await queryClient.resetQueries({ queryKey: ['mount', 'list'] })
                }
                return
            }

            await openCommandWindow('mount', args, context)
        },
    },
    {
        id: 'serve',
        label: 'Serve',
        description: COMMAND_DESCRIPTIONS.serve,
        keywords: COMMAND_KEYWORDS.serve,
        getDefaultResult: () => createBaseResult('Serve', COMMAND_DESCRIPTIONS.serve, {}, 40),
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.serve)) {
                return []
            }

            const results: ToolbarActionResult[] = []

            const activeServes = queryClient.getQueryData(['serve', 'list']) as
                | Awaited<ReturnType<typeof fetchServeList>>
                | undefined

            if (activeServes && activeServes.length > 0) {
                for (const serve of activeServes) {
                    const serveLabel = formatServeLabel(serve)

                    results.push(
                        createBaseResult(
                            `📋 ${serveLabel}`,
                            'Press Enter to copy serve details to clipboard',
                            { _action: 'copy_info', _serveId: serve.id },
                            180
                        )
                    )

                    results.push(
                        createBaseResult(
                            `⏹ Stop ${serveLabel}`,
                            'Stop this serve instance',
                            { _action: 'stop', _serveId: serve.id },
                            175
                        )
                    )
                }

                if (activeServes.length >= 2) {
                    results.push(
                        createBaseResult(
                            `⏹ Stop All Serves (${activeServes.length} active)`,
                            'Stop all running serve instances',
                            { _action: 'stop_all' },
                            170
                        )
                    )
                }
            }

            const queryIsOnlyKeyword =
                !query ||
                (matchesKeyword(query, COMMAND_KEYWORDS.serve) &&
                    query.trim().split(/\s+/).length <= 1)

            if (paths.length === 0 || queryIsOnlyKeyword) {
                results.push(createBaseResult('Serve', COMMAND_DESCRIPTIONS.serve, {}, 40))
            } else {
                const protocol = findServeType(query)

                for (const path of paths.slice(0, 40)) {
                    const args: ToolbarActionArgs = protocol
                        ? { initialSource: normalizePathForArgs(path), initialType: protocol }
                        : { initialSource: normalizePathForArgs(path) }
                    const protocolLabel = protocol ? `${protocol} ` : ''
                    const score = path.isLocal ? 140 : 160

                    results.push(
                        createBaseResult(
                            `Serve ${protocolLabel}${path.readable}`.trim(),
                            COMMAND_DESCRIPTIONS.serve,
                            args,
                            score
                        )
                    )
                }
            }

            return results
        },
        onPress: async (args, context) => {
            if (args._action === 'copy_info') {
                const serveId = args._serveId as string
                const serves = queryClient.getQueryData(['serve', 'list']) as
                    | Awaited<ReturnType<typeof fetchServeList>>
                    | undefined
                const serve = serves?.find((s) => s.id === serveId)

                if (serve) {
                    const info = formatServeInfo(serve)
                    await writeText(info)
                    await message('Serve details copied to clipboard', {
                        title: 'Serve Info',
                        kind: 'info',
                    })
                } else {
                    await message('Serve instance not found. It may have been stopped.', {
                        title: 'Serve Info',
                        kind: 'error',
                    })
                }
                return
            }

            if (args._action === 'stop') {
                const serveId = args._serveId as string
                try {
                    await rclone('/serve/stop', {
                        params: {
                            query: {
                                id: serveId,
                            },
                        },
                    })
                    await notify({
                        title: 'Serve Stopped',
                        body: `Serve instance ${serveId} has been stopped`,
                    })
                    queryClient.setQueryData(
                        ['serve', 'list'],
                        (old: Awaited<ReturnType<typeof fetchServeList>> | undefined) =>
                            old?.filter((s) => s.id !== serveId) ?? []
                    )
                } catch (error) {
                    await reportError(error, {
                        title: 'Stop Serve',
                        fallback: 'Failed to stop serve instance',
                        capture: false,
                        log: ['[toolbar] failed to stop serve'],
                    })
                }
                return
            }

            if (args._action === 'stop_all') {
                try {
                    await rclone('/serve/stopall')
                    await notify({
                        title: 'All Serves Stopped',
                        body: 'All serve instances have been stopped',
                    })
                    queryClient.setQueryData(['serve', 'list'], [])
                } catch (error) {
                    await reportError(error, {
                        title: 'Stop All Serves',
                        fallback: 'Failed to stop all serve instances',
                        capture: false,
                        log: ['[toolbar] failed to stop all serves'],
                    })
                    await queryClient.resetQueries({ queryKey: ['serve', 'list'] })
                }
                return
            }

            await openCommandWindow('serve', args, context)
        },
    },
    {
        id: 'download',
        label: 'Download',
        description: COMMAND_DESCRIPTIONS.download,
        keywords: COMMAND_KEYWORDS.download,
        getDefaultResult: () => createBaseResult('Download', COMMAND_DESCRIPTIONS.download, {}, 45),
        getResults: ({ query, paths }) => {
            const url = findFirstUrl(query)
            const urlLabel = url ? formatUrlLabel(url) : undefined

            if (!url && query && !matchesKeyword(query, COMMAND_KEYWORDS.download)) {
                return []
            }

            const results: ToolbarActionResult[] = []

            if (paths.length > 0) {
                for (const path of paths) {
                    const destinationLabel = formatDestinationLabel(path)
                    const label = urlLabel
                        ? `Download ${urlLabel} to ${destinationLabel}`
                        : `Download to ${destinationLabel}`
                    const args: ToolbarActionArgs = url
                        ? { initialDestination: normalizePathForArgs(path), initialUrl: url }
                        : { initialDestination: normalizePathForArgs(path) }
                    const score = url ? (path.isLocal ? 190 : 200) : path.isLocal ? 150 : 160

                    results.push(
                        createBaseResult(label, COMMAND_DESCRIPTIONS.download, args, score)
                    )
                }
            } else if (url) {
                results.push(
                    createBaseResult(
                        `Download ${urlLabel}`,
                        COMMAND_DESCRIPTIONS.download,
                        { initialUrl: url },
                        170
                    )
                )
            } else {
                results.push(createBaseResult('Download', COMMAND_DESCRIPTIONS.download, {}, 45))
            }

            return results
        },
        onPress: async (args, context) => {
            await openCommandWindow('download', args, context)
        },
    },
    {
        id: 'cleanup',
        label: 'Cleanup',
        description: COMMAND_DESCRIPTIONS.cleanup,
        keywords: COMMAND_KEYWORDS.cleanup,
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.cleanup)) {
                return []
            }

            const supportedRemotePaths = paths.filter((path) => !!path.features?.CleanUp)

            if (supportedRemotePaths.length === 0) {
                return [createBaseResult('Cleanup', COMMAND_DESCRIPTIONS.cleanup, {}, 36)]
            }

            const results: ToolbarActionResult[] = []
            const seenRemotes = new Set<string>()

            for (const path of supportedRemotePaths) {
                const remote = formatDestinationLabel(path)
                if (!remote || seenRemotes.has(remote)) {
                    continue
                }
                seenRemotes.add(remote)

                results.push(
                    createBaseResult(
                        `Cleanup ${remote}`,
                        COMMAND_DESCRIPTIONS.cleanup,
                        { remote },
                        150
                    )
                )
            }

            return results
        },
        onPress: async (args) => {
            const remote =
                typeof args.remote === 'string' && args.remote.length > 0 ? args.remote : undefined

            if (!remote) {
                await notify({
                    title: 'Error',
                    body: 'Please enter a remote name to cleanup',
                })
                return
            }

            try {
                await rclone('/operations/cleanup', {
                    params: {
                        query: {
                            fs: remote,
                            _async: true,
                        },
                    },
                })
                await notify({
                    title: 'Cleanup Started',
                    body: `Cleanup started for ${remote}`,
                })
            } catch (error) {
                console.error('[toolbar] failed to start cleanup task', error)
                await notify({
                    title: 'Cleanup Failed',
                    body: `Could not start cleanup for ${remote}`,
                })
            }
        },
    },
    {
        id: 'browse',
        label: 'Browse',
        description: COMMAND_DESCRIPTIONS.browse,
        keywords: COMMAND_KEYWORDS.browse,
        getResults: ({ query, paths, remotes }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.browse)) {
                return []
            }

            const remotePaths = paths.filter((path) => !path.isLocal)

            if (remotePaths.length === 0) {
                if (remotes.length === 0) {
                    return [
                        createBaseResult('Browse', 'Specify a remote to browse its files', {}, 37),
                    ]
                }

                const results: ToolbarActionResult[] = []
                for (const remote of remotes) {
                    results.push(
                        createBaseResult(
                            `Browse ${remote}`,
                            COMMAND_DESCRIPTIONS.browse,
                            { remote },
                            140
                        )
                    )
                }
                results.push(createBaseResult('Back', 'Return to menu', { _action: 'back' }, 50))
                return results
            }

            const results: ToolbarActionResult[] = []
            const seenRemotes = new Set<string>()

            for (const path of remotePaths) {
                const remote = path.remoteName
                if (!remote || seenRemotes.has(remote)) {
                    continue
                }
                seenRemotes.add(remote)

                results.push(
                    createBaseResult(
                        `Browse ${remote}`,
                        COMMAND_DESCRIPTIONS.browse,
                        { remote },
                        150
                    )
                )
            }

            return results
        },
        onPress: async (args, context) => {
            if (args._action === 'back') {
                context.updateText('')
                return
            }

            const remote =
                typeof args.remote === 'string' && args.remote.length > 0 ? args.remote : undefined

            if (!remote) {
                context.updateText('Browse ')
                return
            }

            try {
                await openFullWindow({
                    name: 'Commander',
                    url: `/commander?path=${encodeURIComponent(`${remote}:/`)}`,
                    hideTitleBar: true,
                })
            } catch (error) {
                captureException(error)
                await message('Could not open Commander window. Please try again.', {
                    title: 'Error',
                    kind: 'error',
                    okLabel: 'OK',
                })
            }
        },
    },
    {
        id: 'delete',
        label: 'Delete',
        description: COMMAND_DESCRIPTIONS.delete,
        keywords: COMMAND_KEYWORDS.delete,
        getDefaultResult: () => createBaseResult('Delete', COMMAND_DESCRIPTIONS.delete, {}, 38),
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.delete)) {
                return []
            }

            if (paths.length === 0) {
                return [createBaseResult('Delete', COMMAND_DESCRIPTIONS.delete, {}, 38)]
            }

            const results: ToolbarActionResult[] = []

            for (const path of paths) {
                const score = path.isLocal ? 140 : 150
                results.push(
                    createBaseResult(
                        `Delete ${path.readable}`,
                        COMMAND_DESCRIPTIONS.delete,
                        { initialSource: normalizePathForArgs(path) },
                        score
                    )
                )
            }

            return results
        },
        onPress: async (args, context) => {
            await openCommandWindow('delete', args, context)
        },
    },
    {
        id: 'purge',
        label: 'Purge',
        description: COMMAND_DESCRIPTIONS.purge,
        keywords: COMMAND_KEYWORDS.purge,
        getDefaultResult: () => createBaseResult('Purge', COMMAND_DESCRIPTIONS.purge, {}, 36),
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.purge)) {
                return []
            }

            const supportedPaths = paths.filter((path) => !!path.features?.Purge)

            if (supportedPaths.length === 0) {
                return [createBaseResult('Purge', COMMAND_DESCRIPTIONS.purge, {}, 36)]
            }

            const results: ToolbarActionResult[] = []

            for (const path of supportedPaths) {
                const score = path.isLocal ? 140 : 150
                results.push(
                    createBaseResult(
                        `Purge ${path.readable}`,
                        COMMAND_DESCRIPTIONS.purge,
                        { initialSource: normalizePathForArgs(path) },
                        score
                    )
                )
            }

            return results
        },
        onPress: async (args, context) => {
            await openCommandWindow('purge', args, context)
        },
    },
    {
        id: 'settings',
        label: 'Settings',
        description: COMMAND_DESCRIPTIONS.settings,
        keywords: COMMAND_KEYWORDS.settings,
        getDefaultResult: () => createBaseResult('Settings', COMMAND_DESCRIPTIONS.settings, {}, 34),
        getResults: ({ query }) => {
            if (query && matchesKeyword(query, COMMAND_KEYWORDS.settings)) {
                return [createBaseResult('Settings', COMMAND_DESCRIPTIONS.settings, {}, 34)]
            }
            return []
        },
        onPress: async (args, context) => {
            await openCommandWindow('settings', args, context)
        },
    },
    {
        id: 'commander',
        label: 'Commander',
        description: COMMAND_DESCRIPTIONS.commander,
        keywords: COMMAND_KEYWORDS.commander,
        getDefaultResult: () =>
            createBaseResult('Commander', COMMAND_DESCRIPTIONS.commander, {}, 32),
        getResults: ({ query }) => {
            if (query && matchesKeyword(query, COMMAND_KEYWORDS.commander)) {
                return [createBaseResult('Commander', COMMAND_DESCRIPTIONS.commander, {}, 32)]
            }
            return []
        },
        onPress: async () => {
            await openFullWindow({
                name: 'Commander',
                url: '/commander',
                hideTitleBar: true,
            })
        },
    },
    {
        id: 'github',
        label: 'GitHub',
        description: COMMAND_DESCRIPTIONS.github,
        keywords: COMMAND_KEYWORDS.github,
        getDefaultResult: () => createBaseResult('GitHub', COMMAND_DESCRIPTIONS.github, {}, 32),
        getResults: ({ query }) => {
            if (query && matchesKeyword(query, COMMAND_KEYWORDS.github)) {
                return [createBaseResult('GitHub', COMMAND_DESCRIPTIONS.github, {}, 32)]
            }
            return []
        },
        onPress: async () => {
            await openUrl('https://github.com/rclone-ui/rclone-ui')
        },
    },
    {
        id: 'transfers',
        label: 'Transfers',
        description: COMMAND_DESCRIPTIONS.transfers,
        keywords: COMMAND_KEYWORDS.transfers,
        getDefaultResult: () =>
            createBaseResult('Transfers', COMMAND_DESCRIPTIONS.transfers, {}, 30),
        getResults: ({ query }) => {
            if (query && matchesKeyword(query, COMMAND_KEYWORDS.transfers)) {
                return [createBaseResult('Transfers', COMMAND_DESCRIPTIONS.transfers, {}, 30)]
            }
            return []
        },
        onPress: async (args, context) => {
            await openCommandWindow('transfers', args, context)
        },
    },
    {
        id: 'schedules',
        label: 'Schedules',
        description: COMMAND_DESCRIPTIONS.schedules,
        keywords: COMMAND_KEYWORDS.schedules,
        getResults: ({ query }) => {
            if (query && matchesKeyword(query, COMMAND_KEYWORDS.schedules)) {
                return [createBaseResult('Schedules', COMMAND_DESCRIPTIONS.schedules, {}, 28)]
            }
            return []
        },
        onPress: async (args, context) => {
            await openCommandWindow('schedules', args, context)
        },
    },
    {
        id: 'templates',
        label: 'Templates',
        description: COMMAND_DESCRIPTIONS.templates,
        keywords: COMMAND_KEYWORDS.templates,
        getDefaultResult: () =>
            createBaseResult('Templates', COMMAND_DESCRIPTIONS.templates, {}, 28),
        getResults: ({ query }) => {
            if (query && matchesKeyword(query, COMMAND_KEYWORDS.templates)) {
                return [createBaseResult('Templates', COMMAND_DESCRIPTIONS.templates, {}, 28)]
            }
            return []
        },
        onPress: async (args, context) => {
            await openCommandWindow('templates', args, context)
        },
    },
    {
        id: 'remoteCreate',
        label: 'New Remote',
        description: COMMAND_DESCRIPTIONS.remoteCreate,
        keywords: COMMAND_KEYWORDS.remoteCreate,
        getDefaultResult: () =>
            createBaseResult(
                'New Remote',
                COMMAND_DESCRIPTIONS.remoteCreate,
                {
                    tab: 'remotes',
                    action: 'create',
                },
                28
            ),
        getResults: ({ query }) => {
            if (query && matchesKeyword(query, COMMAND_KEYWORDS.remoteCreate)) {
                return [
                    createBaseResult(
                        'New Remote',
                        COMMAND_DESCRIPTIONS.remoteCreate,
                        {
                            tab: 'remotes',
                            action: 'create',
                        },
                        28
                    ),
                ]
            }
            return []
        },
        onPress: async (args, context) => {
            await openCommandWindow('settings', args, context)
        },
    },
    {
        id: 'remoteEdit',
        label: 'Edit Remote',
        description: COMMAND_DESCRIPTIONS.remoteEdit,
        keywords: COMMAND_KEYWORDS.remoteEdit,
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.remoteEdit)) {
                return []
            }

            const remotePaths = paths.filter((path) => !path.isLocal)

            const results: ToolbarActionResult[] = []
            const seenRemotes = new Set<string>()

            for (const path of remotePaths) {
                const remote = path.remoteName
                if (!remote || seenRemotes.has(remote)) {
                    continue
                }
                seenRemotes.add(remote)

                results.push(
                    createBaseResult(
                        `Edit ${remote}`,
                        COMMAND_DESCRIPTIONS.remoteEdit,
                        { tab: 'remotes', action: 'edit', remote },
                        140
                    )
                )
            }

            return results
        },

        onPress: async (args, context) => {
            await openCommandWindow('settings', args, context)
        },
    },
    {
        id: 'remoteAutoMount',
        label: 'Auto Mount',
        description: COMMAND_DESCRIPTIONS.remoteAutoMount,
        keywords: COMMAND_KEYWORDS.remoteAutoMount,
        getResults: ({ query, paths }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.remoteAutoMount)) {
                return []
            }

            const remotePaths = paths.filter((path) => !path.isLocal)

            const results: ToolbarActionResult[] = []
            const seenRemotes = new Set<string>()

            for (const path of remotePaths) {
                const remote = path.remoteName
                if (!remote || seenRemotes.has(remote)) {
                    continue
                }
                seenRemotes.add(remote)

                results.push(
                    createBaseResult(
                        `Configure auto mount for ${remote}`,
                        COMMAND_DESCRIPTIONS.remoteAutoMount,
                        { tab: 'remotes', action: 'auto-mount', remote },
                        140
                    )
                )
            }

            return results
        },
        onPress: async (args, context) => {
            await openCommandWindow('settings', args, context)
        },
    },
    {
        id: 'remoteList',
        label: 'Show Remotes',
        description: COMMAND_DESCRIPTIONS.remoteList,
        keywords: COMMAND_KEYWORDS.remoteList,
        getDefaultResult: () =>
            createBaseResult(
                'Show Remotes',
                COMMAND_DESCRIPTIONS.remoteList,
                { tab: 'remotes' },
                32
            ),
        getResults: ({ query }) => {
            if (query && matchesKeyword(query, COMMAND_KEYWORDS.remoteList)) {
                return [
                    createBaseResult(
                        'Show Remotes',
                        COMMAND_DESCRIPTIONS.remoteList,
                        { tab: 'remotes' },
                        32
                    ),
                ]
            }
            return []
        },
        onPress: async (args, context) => {
            await openCommandWindow('settings', args, context)
        },
    },
    {
        id: 'quit',
        label: 'Quit',
        description: COMMAND_DESCRIPTIONS.quit,
        keywords: COMMAND_KEYWORDS.quit,
        getDefaultResult: () => createBaseResult('Quit', COMMAND_DESCRIPTIONS.quit, {}, 20),
        getResults: ({ query }) => {
            if (query && matchesKeyword(query, COMMAND_KEYWORDS.quit)) {
                return [createBaseResult('Quit', COMMAND_DESCRIPTIONS.quit, {}, 20)]
            }
            return []
        },
        onPress: async () => {
            await emitToMain(CLOSE_APP)
        },
    },
    {
        id: 'vfs',
        label: 'VFS',
        description: COMMAND_DESCRIPTIONS.vfs,
        keywords: COMMAND_KEYWORDS.vfs,
        getDefaultResult: () => createBaseResult('VFS', 'Specify a cache to forget', {}, 35),
        getResults: ({ query }) => {
            if (query && !matchesKeyword(query, COMMAND_KEYWORDS.vfs)) {
                return []
            }

            const results: ToolbarActionResult[] = []

            const activeVfses = queryClient.getQueryData(['vfs', 'list']) as string[] | undefined

            if (activeVfses && activeVfses.length > 0) {
                for (const vfs of activeVfses) {
                    results.push(
                        createBaseResult(
                            `Forget ${vfs}`,
                            'Clear the VFS directory cache',
                            { _action: 'forget', _fs: vfs },
                            180
                        )
                    )
                }

                if (activeVfses.length >= 2) {
                    results.push(
                        createBaseResult(
                            `Forget All VFS Caches (${activeVfses.length} active)`,
                            'Clear all VFS directory caches',
                            { _action: 'forget_all' },
                            170
                        )
                    )
                }
            } else {
                results.push(
                    createBaseResult('Back', 'No active VFS caches', { _action: 'back' }, 35)
                )
            }

            return results
        },
        onPress: async (args, context) => {
            if (!args._action) {
                context.updateText('VFS ')
                return
            }

            if (args._action === 'back') {
                context.updateText('')
                return
            }

            if (args._action === 'forget') {
                const fs = args._fs as string
                try {
                    await rclone('/vfs/forget', {
                        params: {
                            query: {
                                fs,
                            },
                        },
                    })
                    await notify({
                        title: 'VFS Cache Cleared',
                        body: `Directory cache for ${fs} has been cleared`,
                    })
                    queryClient.setQueryData(
                        ['vfs', 'list'],
                        (old: string[] | undefined) => old?.filter((v) => v !== fs) ?? []
                    )
                } catch (error) {
                    await reportError(error, {
                        title: 'VFS Forget',
                        fallback: 'Failed to clear VFS cache',
                        capture: false,
                        log: ['[toolbar] failed to forget VFS cache'],
                    })
                }
                return
            }

            if (args._action === 'forget_all') {
                try {
                    await rclone('/vfs/forget')
                    await notify({
                        title: 'All VFS Caches Cleared',
                        body: 'All VFS directory caches have been cleared',
                    })
                    queryClient.setQueryData(['vfs', 'list'], [])
                } catch (error) {
                    await reportError(error, {
                        title: 'VFS Forget All',
                        fallback: 'Failed to clear all VFS caches',
                        capture: false,
                        log: ['[toolbar] failed to forget all VFS caches'],
                    })
                }
                return
            }
        },
    },
]

export function getToolbarActions(): ToolbarActionDefinition[] {
    return actions
}

export function getToolbarAction(id: ToolbarCommandId): ToolbarActionDefinition {
    const action = actions.find((item) => item.id === id)
    if (!action) {
        throw new Error(`Unknown toolbar action: ${id}`)
    }
    return action
}

type CommandConfig = typeof COMMAND_CONFIG
type ConfiguredCommandId = {
    [K in keyof CommandConfig]: CommandConfig[K] extends { route: string; windowLabel: string }
        ? K
        : never
}[keyof CommandConfig]

async function openCommandWindow(
    id: ConfiguredCommandId,
    args: ToolbarActionArgs,
    context: ToolbarActionOnPressContext
): Promise<void> {
    console.log('openCommandWindow', id, args)

    const config = COMMAND_CONFIG[id]

    const commandUrl = buildCommandUrl(id, args)
    console.log('commandUrl', commandUrl)

    await context.openWindow({
        name: config.windowLabel,
        url: commandUrl,
    })
}

function buildCommandUrl(id: ConfiguredCommandId, args: ToolbarActionArgs): string {
    const config = COMMAND_CONFIG[id]
    const params = buildCommandParams(id, args)
    const search = params.toString()
    return search ? `${config.route}?${search}` : config.route
}

function buildCommandParams(id: ConfiguredCommandId, args: ToolbarActionArgs): URLSearchParams {
    const params = new URLSearchParams()
    const setParam = (key: string, value?: string) => {
        if (typeof value === 'string' && value.length > 0) {
            params.set(key, value)
        }
    }

    switch (id) {
        case 'copy':
        case 'move':
        case 'sync':
        case 'bisync':
        case 'mount':
        case 'serve':
        case 'download':
        case 'delete':
        case 'purge':
        case 'settings': {
            for (const key in args) {
                if (args[key]) {
                    setParam(key, args[key])
                }
            }
            break
        }
        default:
            break
    }

    return params
}

function createBaseResult(
    label: string,
    description: string | undefined,
    args: ToolbarActionArgs,
    score: number
): ToolbarActionResult {
    return {
        label,
        description,
        args,
        score,
    }
}

function matchesKeyword(query: string, keywords: string[]): boolean {
    const [first = ''] = query.split(WHITESPACE_SPLIT).filter(Boolean)
    const normalized = first.toLowerCase()
    if (!normalized) return false

    return keywords.some((keyword) => {
        const lowerKeyword = keyword.toLowerCase()
        return lowerKeyword.includes(normalized) || normalized.includes(lowerKeyword)
    })
}

function findServeType(query: string): string | undefined {
    const lower = query.toLowerCase()
    return SERVE_TYPES.find((type) => lower.includes(type))
}

function findFirstUrl(query: string): string | undefined {
    const tokens = query.split(WHITESPACE_SPLIT).filter(Boolean)
    for (const raw of tokens) {
        const token = raw.replace(TOKEN_TRIM_REGEX, '')
        if (!token) continue
        if (token.includes('://')) {
            return token
        }
        if (SIMPLE_URL_REGEX.test(token)) {
            return token.startsWith('http') ? token : `https://${token}`
        }
    }
    return undefined
}

function formatUrlLabel(raw: string): string {
    try {
        const parsed = new URL(raw)
        const pathname = parsed.pathname.replace(TRAILING_SLASH_REGEX, '')
        if (pathname) {
            const segments = pathname.split('/').filter(Boolean)
            if (segments.length > 0) {
                return segments[segments.length - 1]
            }
        }
        return parsed.hostname
    } catch {
        const cleaned = raw.replace(TRAILING_SLASH_REGEX, '')
        const parts = cleaned.split('/').filter(Boolean)
        return parts.length > 0 ? parts[parts.length - 1] : cleaned
    }
}

function normalizePathForArgs(path: ToolbarActionPath): string {
    if (!path.isLocal && !path.full.includes(':/')) {
        return `${path.full}:/`
    }
    return path.full
}

function formatDestinationLabel(path: ToolbarActionPath): string {
    if (!path.isLocal) {
        const colonIndex = path.full.indexOf(':')
        if (colonIndex > 0) {
            return path.full.slice(0, colonIndex)
        }
    }
    return path.readable
}
