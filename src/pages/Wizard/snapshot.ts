// The Wizard as it was left, kept in localStorage for each data folder, because a closed window
// loses its sessionStorage. Opening the Wizard again shows the same step with the same answers.
// "Start over" clears it, and so does opening the plan's operation page.

import { WHEN_CHOICES, type WhenForm } from '../../components/schedule/when'
import { type Answers, type Choice, GOALS, KEEPS, METADATAS, refineFor, WHENS } from './flow'

export interface WizardState {
    answers: Answers
    cursor: number
    /** The answers as they were when the user went to change one from the plan. */
    editing?: Answers
}

export const INITIAL: WizardState = { answers: {}, cursor: 0 }

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string')

const TEXTS = ['destination', 'url', 'templateName'] as const satisfies readonly (keyof Answers)[]
const NUMBERS = ['minute', 'hour', 'weekday', 'monthDay'] as const

function isChoice<K extends string>(choices: readonly Choice<K>[], value: unknown): value is K {
    return choices.some((choice) => choice.key === value)
}

function readSchedule(value: unknown): WhenForm | undefined {
    if (!isObject(value) || !WHEN_CHOICES.some((c) => c.kind === value.kind)) return undefined
    if (typeof value.expression !== 'string') return undefined
    if (NUMBERS.some((key) => !Number.isInteger(value[key]))) return undefined
    return value as unknown as WhenForm
}

/**
 * Reads stored answers. An invalid answer is left out, so its step asks again. A refine is kept
 * only if its goal offers it, because any other names no operation.
 */
function readAnswers(value: unknown): Answers | undefined {
    if (!isObject(value)) return undefined
    const answers: Answers = {}
    const { goal, refine } = value
    if (isChoice(GOALS, goal)) {
        answers.goal = goal
        if (isChoice(refineFor(goal)?.choices ?? [], refine)) answers.refine = refine
    }
    if (isChoice(METADATAS, value.metadata)) answers.metadata = value.metadata
    if (isChoice(WHENS, value.when)) answers.when = value.when
    if (isChoice(KEEPS, value.keep)) answers.keep = value.keep
    for (const key of TEXTS) if (typeof value[key] === 'string') answers[key] = value[key]
    if (isStrings(value.sources)) answers.sources = value.sources
    if (isStrings(value.mapper)) answers.mapper = value.mapper
    const schedule = readSchedule(value.schedule)
    if (schedule) answers.schedule = schedule
    return answers
}

export function readState(stored: unknown): WizardState {
    if (!isObject(stored)) return INITIAL
    const answers = readAnswers(stored.answers)
    const cursor = Number(stored.cursor)
    if (!answers || !Number.isInteger(cursor) || cursor < 0) return INITIAL
    const editing = readAnswers(stored.editing)
    return editing ? { answers, cursor, editing } : { answers, cursor }
}

/** The storage key for a data folder: its places are its own. */
export function stateKey(dataDir: string): string {
    return `wizard:${dataDir}`
}

export function loadState(key: string, storage: Storage | undefined = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(key)
        return raw ? readState(JSON.parse(raw)) : INITIAL
    } catch {
        return INITIAL
    }
}

export function saveState(
    key: string,
    state: WizardState,
    storage: Storage | undefined = globalThis.localStorage
) {
    try {
        storage?.setItem(key, JSON.stringify(state))
    } catch {
        // A full or unavailable storage only means that the Wizard starts fresh next time.
    }
}
