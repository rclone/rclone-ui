import { Kind, type Option } from '../../lib/catalog'

// The answers of the option dialog (DialogHost's OptionDialog), which asks one of rclone's config
// questions with the field that the remote forms use. rclone reads every answer as text, the way
// its CLI wizard does.

/** Whether the option takes one of its choices and nothing else. */
function isClosed(option: Option): boolean {
    return (
        option.choices.length > 0 &&
        (option.exclusive || option.kind === Kind.KindChoice || option.kind === Kind.KindTristate)
    )
}

/**
 * The answer that the dialog starts from. It is rclone's default. A switch starts off when the
 * default isn't "true". When the default isn't one of the choices, the first choice is picked,
 * as rclone's wizard offers the first one. An open set of choices keeps a default that isn't
 * listed, because a typed value is allowed.
 */
export function initialAnswer(option: Option): string {
    const def = option.defaultText
    if (option.kind === Kind.KindBool) return def === 'true' ? 'true' : 'false'
    const choices = option.choices
    if (choices.length === 0 || choices.some((c) => c.value === def)) return def
    if (isClosed(option) || !def) return choices[0].value
    return def
}

/** The answer to send to rclone, from the value that the field holds (undefined if untouched). */
export function answerOf(option: Option, value: unknown): string {
    if (value === undefined || value === null) return initialAnswer(option)
    if (option.kind === Kind.KindBool) return String(value) === 'true' ? 'true' : 'false'
    return String(value)
}
