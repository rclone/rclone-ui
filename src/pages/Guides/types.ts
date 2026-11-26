import { t } from '@lingui/core/macro'
import type { Page as PageIcon } from '@zappicon/react'
import type { Platform } from '../../../lib/shell'

export type Icon = typeof PageIcon

export const CATEGORIES = [
    { id: 'start', title: t`Getting started` },
    { id: 'files', title: t`Moving files` },
    { id: 'automate', title: t`Automating` },
    { id: 'drives', title: t`Drives and sharing` },
    { id: 'app', title: t`Staying informed` },
] as const

export type CategoryId = (typeof CATEGORIES)[number]['id']

export interface Action {
    label: string
    route: string
}

export interface Step {
    text: string
    action?: Action
    os?: Platform[]
}

export interface Section {
    title: string
    text?: string[]
    steps?: Step[]
    tips?: string[]
    os?: Platform[]
}

export interface Guide {
    id: string
    category: CategoryId
    title: string
    summary: string
    icon: Icon
    open?: Action
    sections: Section[]
    related?: string[]
    keywords?: Keywords
}

export interface Keywords {
    english: string[]
    translated: string[]
}
