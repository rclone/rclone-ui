import { createContext, Fragment, type ReactNode, useContext } from 'react'

// The guides' text is plain strings with a little markup, so the content reads like prose:
//   **Schedule**    a label the user sees in the app (a button, a menu item, a field)
//   `gdrive:Photos` a path, a command or anything typed
//   [[shortcut]]    the launcher's shortcut, as the user's own keycaps
//   [[key:K]]       a shortcut with the OS's main modifier: ⌘ K on macOS, Ctrl K elsewhere
//
// Each text is one translated message with its markup inside, so the keys are written in square
// brackets: a message is ICU MessageFormat, where braces start a placeholder.

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[\[shortcut\]\]|\[\[key:[^\]]+\]\])/g
const SHORTCUT = '[[shortcut]]'
const KEY = '[[key:'
const RE_MARKER = /\[\[([^\]]+)\]\]/g
const RE_ACCENT = /\p{M}/gu

/**
 * The text with the keys' markers as they are written. The test language accents every letter of
 * a message, those of a marker too ("[[śĥōŕţćũţ]]"), so the accents are taken off inside them.
 * A real translation keeps the markers as they are, and this changes nothing there.
 */
function withMarkers(text: string): string {
    return text.replace(
        RE_MARKER,
        (_, inner: string) => `[[${inner.normalize('NFD').replace(RE_ACCENT, '')}]]`
    )
}

/** What the keys in the text are drawn with: the launcher's shortcut and whether this is a Mac. */
export interface Keyboard {
    shortcut: readonly string[]
    mac: boolean
}

export const KeyboardContext = createContext<Keyboard>({ shortcut: [], mac: false })

/** The keycaps of a [[key:…]] token on this OS: the main modifier, then the keys. */
export function keyCaps(keys: string, mac: boolean): string[] {
    return [mac ? '⌘' : 'Ctrl', ...keys.split('+')]
}

export function GuideText({ text }: { text: string }) {
    const { shortcut, mac } = useContext(KeyboardContext)
    const parts = withMarkers(text)
        .split(TOKEN)
        .filter((part) => part !== '')
    return (
        <>
            {parts.map((part, index) => {
                const key = `${index}-${part}`
                if (part.startsWith('**')) {
                    return (
                        <strong key={key} className="font-semibold text-foreground">
                            {part.slice(2, -2)}
                        </strong>
                    )
                }
                if (part.startsWith('`')) {
                    return (
                        <code
                            key={key}
                            className="px-1 py-0.5 font-mono text-[0.9em] rounded-small bg-default-100 text-foreground"
                        >
                            {part.slice(1, -1)}
                        </code>
                    )
                }
                if (part === SHORTCUT) return <Keys key={key} caps={shortcut} />
                if (part.startsWith(KEY)) {
                    return <Keys key={key} caps={keyCaps(part.slice(KEY.length, -2), mac)} />
                }
                return <Fragment key={key}>{part}</Fragment>
            })}
        </>
    )
}

export function Keys({ caps }: { caps: readonly string[] }): ReactNode {
    return (
        <span className="inline-flex items-center gap-0.5 align-baseline">
            {caps.map((cap, index) => (
                <kbd
                    key={index}
                    className="inline-flex items-center justify-center min-w-5 h-5 px-1 font-sans text-tiny font-medium border rounded-small border-default-300 bg-default-50 text-foreground"
                >
                    {cap}
                </kbd>
            ))}
        </span>
    )
}

const RE_LABEL = /\*\*([^*]+)\*\*/g
const RE_TYPED = /`([^`]+)`/g
const RE_KEYS = /\[\[(?:shortcut|key:[^\]]+)\]\]/g

/** The guide's text with its markup removed, for search. Keys have no words to find. */
export function plainText(text: string): string {
    return withMarkers(text).replace(RE_LABEL, '$1').replace(RE_TYPED, '$1').replace(RE_KEYS, '')
}
