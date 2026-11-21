import { cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import {
    GlobeSimple as GlobeSimpleIcon,
    LifeRing as LifeRingIcon,
    PowerOff as PowerOffIcon,
    Search as SearchIcon,
    Shield as ShieldIcon,
    SparklesAi as SparklesAiIcon,
    Sun as SunIcon,
} from '@zappicon/react'
import type { ComponentType } from 'react'
import type { Tone } from '../../components/look/tones'
import { LOGO_MASK } from './AboutHeader'

function RcloneMark({ className }: { className?: string }) {
    return <span className={cn('size-[58%] bg-current', className)} style={LOGO_MASK} />
}

export interface Section {
    title: string
    description: string
    icon: ComponentType<{ className?: string }>
    tone: Tone
}

/**
 * The groups of the Settings window, in the order that the window shows them. The key is the
 * group's anchor, which `/settings?section=` opens.
 */
export const SECTIONS = {
    appearance: {
        title: t`Appearance`,
        description: t`How Rclone UI looks, and where it shows.`,
        icon: SunIcon,
        tone: 'violet',
    },
    startup: {
        title: t`Startup`,
        description: t`What happens when you log in, and when Rclone UI starts.`,
        icon: PowerOffIcon,
        tone: 'green',
    },
    launcher: {
        title: t`Launcher`,
        description: t`The search that opens from any app, to start anything in Rclone UI.`,
        icon: SearchIcon,
        tone: 'blue',
    },
    network: {
        title: t`Network`,
        description: t`How fast rclone may transfer, and the proxy that it goes through.`,
        icon: GlobeSimpleIcon,
        tone: 'indigo',
    },
    rclone: {
        // rclone's name, which is the same in every language.
        title: 'Rclone',
        description: t`The rclone that Rclone UI runs, in your terminal too.`,
        icon: RcloneMark,
        // rclone's own color.
        tone: 'sky',
    },
    agents: {
        title: t({
            message: 'Agents',
            comment:
                'A group of Settings: the AI agents, such as Claude or ChatGPT, that may use the app.',
        }),
        description: t`Let an AI agent, such as Claude or ChatGPT, use Rclone UI for you.`,
        icon: SparklesAiIcon,
        tone: 'fuchsia',
    },
    privacy: {
        title: t`Privacy`,
        description: t`What Rclone UI shares about how it is used, and what it never does.`,
        icon: ShieldIcon,
        tone: 'cyan',
    },
    help: {
        title: t`Help`,
        description: t`Ask for a feature, or report a problem with what helps fix it.`,
        icon: LifeRingIcon,
        tone: 'pink',
    },
} as const satisfies Record<string, Section>

export type SectionId = keyof typeof SECTIONS

export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[]
