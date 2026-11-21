import {
    Button,
    cn,
    Kbd,
    Modal,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { MotionConfig } from 'framer-motion'
import { type ComponentType, type ReactNode, useState } from 'react'
import { platform } from '../../../lib/shell'
import { DragScene, KeysScene, PlacesScene, SettingsScene } from './introScenes'

function Key({ children }: { children: ReactNode }) {
    return <Kbd className="px-1.5 py-0 text-xs">{children}</Kbd>
}

interface Step {
    title: string
    body: ReactNode
    Scene: ComponentType
}

function useSteps(): Step[] {
    const mod = platform() === 'macos' ? '⌘' : 'Ctrl+'
    const up = `${mod}↑`
    const search = `${mod}F`
    const refresh = `${mod}R`
    return [
        {
            title: t`Navigate quickly`,
            body: t`Each panel opens a place from its sidebar: a remote, a disk or folder on this computer, or a favorite. Put one place on each side.`,
            Scene: PlacesScene,
        },
        {
            title: t`Drag files across`,
            body: t`Select files in one panel and drag them onto the other. When you drop them, choose whether to copy or move them.`,
            Scene: DragScene,
        },
        {
            title: t`Hold Shift to see names`,
            body: (
                <Trans comment="The keys are shortcuts, such as ⌘↑ on a Mac and Ctrl+↑ elsewhere.">
                    The sidebars show places as icons. Hold <Key>Shift</Key> to see their names.{' '}
                    <Key>{up}</Key> opens the parent folder and <Key>{search}</Key> searches it.{' '}
                    <Key>{refresh}</Key> refreshes both panels.
                </Trans>
            ),
            Scene: KeysScene,
        },
        {
            title: t`Panel settings`,
            body: t`The cog at the bottom left opens the panel settings. There you choose whether folders on this computer show their sizes, and which disks and folders the sidebars offer.`,
            Scene: SettingsScene,
        },
    ]
}

/** Commander's intro: what its panels do, one step at a time, each with a small animation. */
export default function IntroDialog({ onClose }: { onClose: () => void }) {
    const steps = useSteps()
    const [open, setOpen] = useState(true)
    const [step, setStep] = useState(0)
    const { title, body, Scene } = steps[step]
    const last = step === steps.length - 1
    const count = steps.length
    const number = step + 1

    const close = () => {
        setOpen(false)
        onClose()
    }

    return (
        <Modal isOpen={open} onClose={close} placement="center" size="2xl">
            <ModalContent>
                <div aria-hidden={true} className="p-3 pb-0">
                    <div className="h-64 p-4 overflow-hidden rounded-xl bg-gradient-to-br from-primary-50 via-default-50 to-default-100 dark:from-primary-500/15 dark:via-white/[0.02] dark:to-white/[0.04]">
                        <MotionConfig reducedMotion="user">
                            <Scene key={step} />
                        </MotionConfig>
                    </div>
                </div>
                {/* Focus stays on the buttons, so a screen reader reads each step from here. */}
                <div aria-live="polite">
                    <ModalHeader className="pb-1">{title}</ModalHeader>
                    <ModalBody>
                        <p className="text-sm leading-relaxed text-default-600 text-pretty">
                            {body}
                        </p>
                    </ModalBody>
                </div>
                <ModalFooter className="items-center">
                    <span className="sr-only">
                        <Trans>
                            Step {number} of {count}
                        </Trans>
                    </span>
                    <span aria-hidden={true} className="flex gap-1.5 mr-auto">
                        {steps.map((s, i) => (
                            <span
                                key={s.title}
                                className={cn(
                                    'h-1.5 rounded-full transition-[width,background-color] duration-300',
                                    i === step ? 'w-5 bg-primary' : 'w-1.5 bg-default-300'
                                )}
                            />
                        ))}
                    </span>
                    {step > 0 && (
                        <Button variant="light" onPress={() => setStep(step - 1)}>
                            {t({ message: 'Back', comment: 'Button: the previous step.' })}
                        </Button>
                    )}
                    <Button color="primary" onPress={() => (last ? close() : setStep(step + 1))}>
                        {last
                            ? t({ message: 'Done', comment: 'Button: closes the last step.' })
                            : t({ message: 'Next', comment: 'Button: the next step.' })}
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    )
}
