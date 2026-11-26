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
