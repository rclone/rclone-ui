import { Kind, type Option } from '../../lib/catalog'

function isClosed(option: Option): boolean {
    return (
        option.choices.length > 0 &&
        (option.exclusive || option.kind === Kind.KindChoice || option.kind === Kind.KindTristate)
    )
}

export function initialAnswer(option: Option): string {
    const def = option.defaultText
    if (option.kind === Kind.KindBool) return def === 'true' ? 'true' : 'false'
    const choices = option.choices
    if (choices.length === 0 || choices.some((c) => c.value === def)) return def
    if (isClosed(option) || !def) return choices[0].value
    return def
}

export function answerOf(option: Option, value: unknown): string {
    if (value === undefined || value === null) return initialAnswer(option)
    if (option.kind === Kind.KindBool) return String(value) === 'true' ? 'true' : 'false'
    return String(value)
}

/**
 * Whether a question's answer is one of its choices, so the dialog lists them all, as rclone's
 * command line does.
 */
export function isChoiceQuestion(option: Option): boolean {
    return (
        option.choices.length > 0 && option.kind !== Kind.KindBool && option.kind !== Kind.KindFlags
    )
}

/** Whether a choice question also takes a value that isn't one of its choices. */
export function takesOtherValue(option: Option): boolean {
    return !isClosed(option)
}

export const OTHER_VALUE = '\u0000other'

/** The choice that starts picked, or OTHER_VALUE with the typed text when the default isn't one. */
export function initialPick(option: Option): { pick: string; typed: string } {
    const first = initialAnswer(option)
    if (option.choices.some((choice) => choice.value === first)) return { pick: first, typed: '' }
    return { pick: OTHER_VALUE, typed: first }
}

export function pickedAnswer(pick: string, typed: string): string {
    return pick === OTHER_VALUE ? typed : pick
}
