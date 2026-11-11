import { t } from '@lingui/core/macro'
import type { Page as PageIcon } from '@zappicon/react'
import type { Platform } from '../../../lib/shell'

// The shape of a guide. The text uses the small markup that GuideText draws (text.tsx):
// **labels**, `typed text`, [[shortcut]] and [[key:K]].

export type Icon = typeof PageIcon

/** The groups that the sidebar lists the guides in, in this order. */
export const CATEGORIES = [
    { id: 'start', title: t`Getting started` },
    { id: 'files', title: t`Moving files` },
    { id: 'automate', title: t`Automating` },
    { id: 'drives', title: t`Drives and sharing` },
    { id: 'app', title: t`Staying informed` },
] as const

export type CategoryId = (typeof CATEGORIES)[number]['id']

/** A button that opens a window of the app, such as "Open Schedules" (route "/schedules"). */
export interface Action {
    label: string
    route: string
}

/** One numbered step. `os` keeps it to the machines it applies to. */
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
    /** Its id in a link: /guides?guide={id}. */
    id: string
    category: CategoryId
    title: string
    /** One line on its card, and under its title. */
    summary: string
    icon: Icon
    /** The window that the guide is about, offered at its top. */
    open?: Action
    sections: Section[]
    /** The ids of guides to read next. */
    related?: string[]
    /** More words to find it by in the search. */
    keywords?: Keywords
}

/**
 * A guide's search words. The English ones find it in every language, and the translated ones in
 * the app's language. Names that read the same everywhere (`webdav`, `dropbox`) are only in
 * English.
 */
export interface Keywords {
    english: string[]
    translated: string[]
}
