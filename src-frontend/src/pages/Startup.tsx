import { Button, Divider } from '@heroui/react'
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { quit as exit } from '../../lib/api/app'
import { on as onAppEvent } from '../../lib/api/events'
import { useLifecyclePhase } from '../../lib/api/lifecycle'
import { currentLabel, toolbarShow, windowClose, windowHide } from '../../lib/api/native'
import { platform } from '../../lib/api/os'
import { usePersistedStore } from '../../store/persisted'

const GREET = [
    'Hello',
    'こんにちは',
    'Salut',
    'Cześć',
    'Hej',
    'Bonjour',
    'Olá',
    'Ciao',
    '你好',
    'Hallo',
    'Merhaba',
    'مرحباً',
]

const WAIT = [
    'Just a moment',
    '少々お待ちください',
    'Un moment',
    'Chwileczkę',
    'Ett ögonblick',
    'Juste un instant',
    'Só um momento',
    'Un attimo',
    '请稍等一下',
    'Einen Moment, bitte',
    'Bir saniye lütfen',
    'لحظة من فضلك',
]

export default function Startup() {
    const [titleIndex, setTitleIndex] = useState(0)

    // The startup vocabulary is derived from the orchestrator's phase: a successful auto-update
    // shows as 'updated' until the window closes.
    const phase = useLifecyclePhase()
    const startupStatus = useMemo(() => {
        if (!phase) return 'initializing' as const
        switch (phase.phase) {
            case 'updating':
                return 'updating' as const
            case 'ready':
                return phase.updated ? ('updated' as const) : ('initialized' as const)
            case 'failed':
                return phase.fatal ? ('fatal' as const) : ('error' as const)
            case 'needsPassword':
                return 'error' as const
            default:
                return 'initializing' as const
        }
    }, [phase])
    const toolbarShortcut = usePersistedStore((state) => state.toolbarShortcut)

    const shortcutDisplay = useMemo(() => {
        const raw = toolbarShortcut ?? 'CmdOrCtrl+Shift+/'
        return raw
            .split('+')
            .map((part) =>
                part === 'CmdOrCtrl'
                    ? platform === 'macos'
                        ? '⌘'
                        : 'Ctrl'
                    : part === 'Command'
                      ? '⌘'
                      : part
            )
            .join(' + ')
    }, [toolbarShortcut])

    const isError = useMemo(
        () => startupStatus === 'error' || startupStatus === 'fatal',
        [startupStatus]
    )

    useEffect(() => {
        let intervalId: NodeJS.Timeout | null = null
        if (startupStatus === 'initializing') {
            intervalId = setInterval(() => {
                setTitleIndex((previousIndex) => (previousIndex + 1) % GREET.length)
            }, 1500)
        } else if (startupStatus === 'updating') {
            intervalId = setInterval(() => {
                setTitleIndex((previousIndex) => (previousIndex + 1) % WAIT.length)
            }, 2000)
        }
        return () => {
            if (intervalId) {
                clearInterval(intervalId)
            }
        }
    }, [startupStatus])

    // Close window when it loses focus
    // Wayland can report a transient focus loss while the window is being shown.
    useEffect(() => {
        const label = currentLabel()
        if (!label) return
        return onAppEvent('window.blur', async (event) => {
            if (event.label === label && platform !== 'linux') {
                await windowHide()
                await windowClose()
            }
        })
    }, [])

    return (
        <div className="flex flex-col h-screen rounded-2xl bg-content1">
            <img src="/banner.png" alt="Rclone UI" className="w-full h-auto p-5" />

            <Divider />

            <div className="flex flex-col w-full h-full justify-evenly">
                <div className="flex flex-col items-center w-full gap-8 overflow-visible">
                    <AnimatePresence mode="wait">
                        {isError && (
                            <motion.p
                                key="error"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="ml-2 text-2xl"
                            >
                                Could not complete the operation, please try again later.
                            </motion.p>
                        )}
                        {startupStatus === 'initialized' && (
                            <motion.p
                                key="initialized"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="ml-2 text-2xl"
                            >
                                Use the {shortcutDisplay} shortcut to open the Toolbar!
                            </motion.p>
                        )}
                        {startupStatus === 'updated' && (
                            <motion.p
                                key="updated"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="ml-2 text-2xl"
                            >
                                Rclone has just been updated, thanks for waiting!
                            </motion.p>
                        )}
                        {startupStatus === 'initializing' && (
                            <motion.p
                                key="initializing"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="ml-2 text-3xl"
                            >
                                <span
                                    key={titleIndex}
                                    className="inline-block align-middle animate-fade-in-up"
                                >
                                    {GREET[titleIndex]}
                                </span>{' '}
                                <span className="inline-block align-middle">👋</span>
                            </motion.p>
                        )}
                        {startupStatus === 'updating' && (
                            <motion.p
                                key="updating"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="ml-2 text-3xl"
                            >
                                <span
                                    key={titleIndex}
                                    className="inline-block align-middle animate-fade-in-up"
                                >
                                    {WAIT[titleIndex]}
                                </span>{' '}
                                <span className="inline-block align-middle">👋</span>
                            </motion.p>
                        )}
                    </AnimatePresence>
                </div>
                <div className="flex flex-col items-center w-full bg-red-500/0">
                    <AnimatePresence mode="wait">
                        {(startupStatus === 'initialized' || startupStatus === 'updated') && (
                            <motion.div
                                key="start-button"
                                className="w-full max-w-md"
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                            >
                                <Button
                                    className="w-full py-8 text-large"
                                    variant="shadow"
                                    color="primary"
                                    size="lg"
                                    onPress={async () => {
                                        await windowHide()

                                        await toolbarShow()

                                        await new Promise((resolve) => setTimeout(resolve, 690))

                                        await windowClose()
                                    }}
                                >
                                    TAP TO START
                                </Button>
                            </motion.div>
                        )}
                        {isError && (
                            <motion.div
                                key="error-button"
                                className="w-full max-w-md"
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                            >
                                <Button
                                    className="w-full py-8 text-large"
                                    variant="shadow"
                                    color="primary"
                                    size="lg"
                                    onPress={async () => {
                                        if (startupStatus === 'error') {
                                            await windowHide()
                                            await windowClose()
                                        } else {
                                            await exit()
                                        }
                                    }}
                                >
                                    {startupStatus === 'error' ? 'OK' : 'QUIT'}
                                </Button>
                            </motion.div>
                        )}
                        {startupStatus === 'initializing' && (
                            <motion.p
                                key="initializing"
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                className="uppercase text-small"
                            >
                                <motion.span
                                    animate={{ opacity: [1, 0.5, 1] }}
                                    transition={{
                                        repeat: Number.POSITIVE_INFINITY,
                                        duration: 4,
                                        ease: 'easeInOut',
                                    }}
                                >
                                    Rclone is initializing
                                </motion.span>
                            </motion.p>
                        )}
                        {startupStatus === 'updating' && (
                            <motion.p
                                key="updating"
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                className="uppercase text-small"
                            >
                                <motion.span
                                    animate={{ opacity: [1, 0.5, 1] }}
                                    transition={{
                                        repeat: Number.POSITIVE_INFINITY,
                                        duration: 4,
                                        ease: 'easeInOut',
                                    }}
                                >
                                    Rclone is updating
                                </motion.span>
                            </motion.p>
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    )
}
