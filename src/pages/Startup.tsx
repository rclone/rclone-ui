import { Button, Kbd } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { useSettings } from '../../lib/settings'
import {
    CoreState,
    type CoreStatus,
    core,
    currentWindow,
    launcher,
    platform,
    quit,
} from '../../lib/shell'
import { toneButton } from '../components/look/buttons'
import { StatusDot } from '../components/look/Status'
import { TONE_RGB } from '../components/look/tones'

// A greeting in many languages, shown one after the other whatever the app's language is.
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

export default function Startup() {
    const [titleIndex, setTitleIndex] = useState(0)

    const [coreStatus, setCoreStatus] = useState<CoreStatus | null>(null)
    useEffect(() => core.onState(setCoreStatus), [])
    // Before the first status, and while a quit stops the core, the screen shows the core starting.
    const state =
        coreStatus?.state === CoreState.CoreReady || coreStatus?.state === CoreState.CoreFailed
            ? coreStatus.state
            : CoreState.CoreStarting
    const { settings } = useSettings()
    const launcherShortcut = settings?.general?.launcherShortcut

    const shortcutKeys = useMemo(() => {
        const raw = launcherShortcut || launcher.defaultShortcut()
        return raw
            .split('+')
            .map((part) =>
                part === 'CmdOrCtrl'
                    ? platform() === 'macos'
                        ? '⌘'
                        : 'Ctrl'
                    : part === 'Command'
                      ? '⌘'
                      : part
            )
    }, [launcherShortcut])
    const keys = shortcutKeys.map((key) => (
        <Kbd key={key} className="px-2 py-0.5 font-sans text-base font-semibold">
            {key}
        </Kbd>
    ))
    const reduceMotion = useReducedMotion()

    const isError = state === CoreState.CoreFailed

    useEffect(() => {
        if (state !== CoreState.CoreStarting) return
        const intervalId = setInterval(() => {
            setTitleIndex((previousIndex) => (previousIndex + 1) % GREET.length)
        }, 1500)
        return () => clearInterval(intervalId)
    }, [state])

    // Close the window when it loses focus, unless the core failed. In that case the error and its
    // QUIT button stay until the user has seen them. Linux is skipped, because Wayland can report
    // a brief focus loss while the window is being shown.
    useEffect(() => {
        if (state === CoreState.CoreFailed) return
        return currentWindow.onBlur(async () => {
            if (platform() !== 'linux') {
                await currentWindow.hide()
                await currentWindow.close()
            }
        })
    }, [state])

    const fade = reduceMotion
        ? { initial: false as const }
        : {
              initial: { opacity: 0, y: 6 },
              animate: { opacity: 1, y: 0 },
              exit: { opacity: 0, y: -6 },
              transition: { type: 'spring' as const, duration: 0.4, bounce: 0 },
          }

    return (
        // The window is transparent and frameless: this rounded card is all of it.
        <div className="relative flex flex-col h-screen overflow-hidden rounded-2xl bg-content1">
            <div
                aria-hidden={true}
                className="absolute inset-x-0 top-0 pointer-events-none h-80"
                style={{
                    background: `radial-gradient(60% 70% at 50% 0%, rgb(${TONE_RGB[isError ? 'red' : 'blue']} / 0.18), transparent 75%)`,
                }}
            />
            <img src="/banner.png" alt="Rclone UI" className="relative w-full h-auto px-5 pt-5" />

            <div className="relative flex flex-col items-center justify-center flex-1 gap-5 px-10 pb-8 text-center">
                <div className="flex flex-col items-center justify-center gap-2 min-h-16">
                    <AnimatePresence mode="wait">
                        {isError && (
                            <motion.div
                                key="error"
                                {...fade}
                                className="flex flex-col items-center gap-1.5"
                            >
                                <p className="text-2xl font-semibold tracking-tight font-rounded">
                                    <Trans>Could not complete the operation</Trans>
                                </p>
                                <p className="max-w-md text-sm leading-relaxed text-default-500 text-pretty">
                                    {coreStatus?.error || t`Please try again later.`}
                                </p>
                            </motion.div>
                        )}
                        {state === CoreState.CoreReady && (
                            <motion.p
                                key="initialized"
                                {...fade}
                                className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xl font-medium tracking-tight font-rounded"
                            >
                                <Trans comment="{keys} is the launcher's keyboard shortcut, shown as key caps.">
                                    Use the{' '}
                                    <span className="inline-flex items-center gap-1">{keys}</span>{' '}
                                    shortcut to open the Launcher!
                                </Trans>
                            </motion.p>
                        )}
                        {state === CoreState.CoreStarting && (
                            <motion.p
                                key="initializing"
                                {...fade}
                                className="text-[34px] font-semibold tracking-tight font-rounded"
                            >
                                <span
                                    key={titleIndex}
                                    className="inline-block align-middle motion-safe:animate-fade-in-up"
                                >
                                    {GREET[titleIndex]}
                                </span>{' '}
                                <span className="inline-block align-middle">👋</span>
                            </motion.p>
                        )}
                    </AnimatePresence>
                </div>
                <div className="flex flex-col items-center w-full">
                    <AnimatePresence mode="wait">
                        {state === CoreState.CoreReady && (
                            <motion.div key="start-button" {...fade} className="w-full max-w-sm">
                                <Button
                                    className={`w-full h-12 text-base font-semibold rounded-2xl ${toneButton('blue')}`}
                                    color="primary"
                                    size="lg"
                                    onPress={async () => {
                                        await currentWindow.hide()

                                        await launcher.show()

                                        await new Promise((resolve) => setTimeout(resolve, 690))

                                        await currentWindow.close()
                                    }}
                                >
                                    <Trans>Tap to start</Trans>
                                </Button>
                            </motion.div>
                        )}
                        {isError && (
                            <motion.div key="error-button" {...fade} className="w-full max-w-sm">
                                <Button
                                    className="w-full h-12 text-base font-semibold rounded-2xl"
                                    variant="flat"
                                    size="lg"
                                    onPress={() => quit()}
                                >
                                    <Trans comment="Button: quits the app.">Quit</Trans>
                                </Button>
                            </motion.div>
                        )}
                        {state === CoreState.CoreStarting && (
                            <motion.p
                                key="initializing"
                                {...fade}
                                className="flex items-center gap-2 text-sm text-default-500"
                            >
                                <StatusDot kind="active" />
                                <Trans>Rclone is initializing…</Trans>
                            </motion.p>
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </div>
    )
}
