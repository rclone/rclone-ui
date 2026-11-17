import * as Sentry from '@sentry/browser'
import { invoke } from '@tauri-apps/api/core'
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu'
import { resolveResource } from '@tauri-apps/api/path'
import { TrayIcon, type TrayIconEvent } from '@tauri-apps/api/tray'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { message } from '@tauri-apps/plugin-dialog'
import { platform } from '@tauri-apps/plugin-os'
import { exit } from '@tauri-apps/plugin-process'
import { usePersistedStore } from '../store/persisted'
import { CLOSE_APP, emitToMain } from './events'
import { openFullWindow, openWindow } from './window'

async function buildMenu() {
    console.log('[buildMenu]')

    const menuItems: (MenuItem | PredefinedMenuItem)[] = []

    const openMenuItem = await MenuItem.new({
        id: 'open',
        text: 'Open',
        action: async () => {
            if (usePersistedStore.getState().acknowledgements.includes('openShortcut')) {
                await invoke('show_toolbar')
                return
            }

            const result = await message(
                `You can also open the Toolbar using the default shortcut ${platform() === 'macos' ? 'Command + Shift + /' : 'Control + Shift + /'}.`,
                {
                    title: 'Did you know?',
                    kind: 'info',
                    buttons: {
                        ok: 'Good to know',
                    },
                }
            )

            if (result !== 'Good to know' && result !== 'Ok') {
                return
            }

            usePersistedStore.setState((prev) => {
                if (prev.acknowledgements.includes('openShortcut')) {
                    return prev
                }

                return {
                    acknowledgements: [...prev.acknowledgements, 'openShortcut'],
                }
            })

            await invoke('show_toolbar')
        },
    })
    menuItems.push(openMenuItem)

    await PredefinedMenuItem.new({
        item: 'Separator',
    }).then((item) => {
        menuItems.push(item)
    })

    const commanderMenuItem = await MenuItem.new({
        id: 'commander',
        text: 'Commander',
        action: async () => {
            await openFullWindow({
                name: 'Commander',
                url: '/commander',
            })
        },
    })
    menuItems.push(commanderMenuItem)

    const transfersMenuItem = await MenuItem.new({
        id: 'transfers',
        text: 'Transfers',
        action: async () => {
            await openWindow({
                name: 'Transfers',
                url: '/transfers',
            })
        },
    })
    menuItems.push(transfersMenuItem)

    const schedulesMenuItem = await MenuItem.new({
        id: 'schedules',
        text: 'Schedules',
        action: async () => {
            await openWindow({
                name: 'Schedules',
                url: '/schedules',
            })
        },
    })
    menuItems.push(schedulesMenuItem)

    const templatesMenuItem = await MenuItem.new({
        id: 'templates',
        text: 'Templates',
        action: async () => {
            await openWindow({
                name: 'Templates',
                url: '/templates',
            })
        },
    })
    menuItems.push(templatesMenuItem)

    await PredefinedMenuItem.new({
        item: 'Separator',
    }).then((item) => {
        menuItems.push(item)
    })

    const settingsItem = await MenuItem.new({
        id: 'settings',
        text: 'Settings',
        action: async () => {
            await openWindow({
                name: 'Settings',
                url: '/settings',
            })
        },
    })
    menuItems.push(settingsItem)

    const quitItem = await MenuItem.new({
        id: 'quit',
        text: 'Quit',
        action: async () => {
            await emitToMain(CLOSE_APP)
        },
    })
    menuItems.push(quitItem)

    return await Menu.new({
        id: 'main-menu',
        items: menuItems,
    })
}

async function resolveTrayIconForTheme() {
    console.log('[resolveTrayIconForTheme]')

    const existingTheme = usePersistedStore.getState().appearance
    console.log('[resolveTrayIconForTheme] existingTheme', existingTheme)

    const isLinuxMint = platform() === 'linux' && (await invoke<boolean>('is_linux_mint'))
    const suffix = isLinuxMint ? '-padded' : ''

    if (existingTheme.tray === 'color') {
        return await resolveResource(`icons/favicon/icon-color${suffix}.png`)
    }

    if (existingTheme.tray === 'system') {
        if (platform() === 'macos') {
            return await resolveResource('icons/favicon/icon.png')
        }

        try {
            const currentWindow = getCurrentWindow()
            const windowTheme = await currentWindow.theme()
            console.log('[resolveTrayIconForTheme] windowTheme', windowTheme)

            const pickedPath =
                windowTheme === 'dark'
                    ? `icons/favicon/icon${suffix}.png`
                    : `icons/favicon/icon-light${suffix}.png`

            return await resolveResource(pickedPath)
        } catch {
            await message('Failed to get window theme', {
                title: 'Error',
                kind: 'error',
            })
            await new Promise((resolve) => setTimeout(resolve, 5000))
            await exit()
        }
    }

    const pickedPath =
        existingTheme.tray === 'dark'
            ? `icons/favicon/icon-light${suffix}.png`
            : `icons/favicon/icon${suffix}.png`

    return await resolveResource(pickedPath)
}

export async function initTray() {
    console.log('[initTray] platform', platform())

    try {
        console.log('[initTray]')

        await TrayIcon.new({
            id: 'rclone-menu5',
            menu: await buildMenu(),
            icon: await resolveTrayIconForTheme(),
            tooltip: 'Rclone',
            showMenuOnLeftClick: platform() === 'macos',
            iconAsTemplate: true,
            action: async (event: TrayIconEvent) => {
                if (platform() === 'macos') return
                if (event.type === 'Click' && event.button === 'Left') {
                    await invoke('show_toolbar')
                }
            },
        })
    } catch (error) {
        Sentry.captureException(error)
        console.error('[initTray] failed to create tray')
        console.error(error)
    }
}
