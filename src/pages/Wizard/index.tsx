import { Button, cn, Input } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import {
    ArrowLeftSmall as ArrowLeftSmallIcon,
    ArrowRightSmall as ArrowRightSmallIcon,
} from '@zappicon/react'
import { type ReactNode, useEffect, useId, useReducer, useRef, useState } from 'react'
import { useFlags } from '../../../lib/catalog'
import { reportError } from '../../../lib/errors'
import { pathProblem } from '../../../lib/paths'
import { useWhenDescription } from '../../../lib/schedules'
import { currentWindow, dataDir, openWindow, platform } from '../../../lib/shell'
import { saveTemplate } from '../../../lib/templates'
import { toneButton } from '../../components/look/buttons'
import { IconTile } from '../../components/look/IconTile'
import { Panel } from '../../components/look/Panel'
import { TONE_GRADIENT, TONE_TEXT } from '../../components/look/tones'
import MetadataMapper from '../../components/MetadataMapper'
import OperationWindowFooter from '../../components/OperationWindowFooter'
import {
    bareField,
    MultiPathField,
    PathField,
    RouteLink,
    RoutePanel,
    RouteRow,
} from '../../components/PathFinder'
import WhenField from '../../components/schedule/WhenField'
import { DEFAULT_WHEN, toCron } from '../../components/schedule/when'
import { WINDOWS, type WindowLook } from '../../routes'
import { isDrive } from '../Mount/mountPoint'
import {
    type Answers,
    cronFor,
    GOAL_QUESTION,
    GOALS,
    type Goal,
    type Info,
    infoFor,
    KEEP_QUESTION,
    KEEPS,
    type Keep,
    METADATA_QUESTION,
    METADATAS,
    type Metadata,
    metadataPhrase,
    OPERATION_ICON,
    OPERATION_LABEL,
    OPERATION_TONE,
    type Operation,
    operationFor,
    pathsOf,
    placesFor,
    placesPhrase,
    type Refine,
    refineFor,
    routeFor,
    type StepKey,
    sentence,
    stepComplete,
    stepCount,
    stepsFor,
    templateFor,
    WHEN_QUESTION,
    WHENS,
    type When,
    whenPhrase,
    withRefine,
} from './flow'
import OptionCards from './OptionCards'
import StepInfo from './StepInfo'
import { INITIAL, loadState, saveState, stateKey, type WizardState } from './snapshot'

type Action =
    | { type: 'goal'; goal: Goal }
    | { type: 'refine'; refine: Refine }
    | { type: 'metadata'; metadata: Metadata }
    | { type: 'when'; when: When }
    | { type: 'keep'; keep: Keep }
    | { type: 'set'; patch: Partial<Answers> }
    | { type: 'next' }
    | { type: 'back' }
    | { type: 'goto'; step: StepKey }
    | { type: 'reset' }

const planIndex = (answers: Answers) => stepsFor(answers).length - 1

/** The picks that open more to fill in on the same step, so the step waits for Continue. */
const stays = (action: Action) =>
    (action.type === 'metadata' && action.metadata === 'map') ||
    (action.type === 'when' && action.when === 'schedule') ||
    (action.type === 'keep' && action.keep === 'template')

function forward(state: WizardState, answers: Answers, cursor: number): WizardState {
    return state.editing && stepsFor(answers).every((step) => stepComplete(step, answers))
        ? { answers, cursor: planIndex(answers) }
        : { ...state, answers, cursor }
}

// A pick moves on by itself, and the steps that take typing wait for Continue. Back keeps the
// answers, except back to the first step, which starts afresh. Change on the plan keeps the
// answers in `editing`: a pick or Done returns to the plan, and "Back to plan" restores them.
function reducer(state: WizardState, action: Action): WizardState {
    const { answers, cursor } = state
    switch (action.type) {
        case 'goal': {
            // A different goal is a different path: the answers after it no longer apply.
            if (answers.goal !== action.goal) return { answers: { goal: action.goal }, cursor: 1 }
            return refineFor(action.goal) ? { ...state, cursor: 1 } : forward(state, answers, 1)
        }
        case 'refine':
            return forward(state, withRefine(answers, action.refine), cursor + 1)
        case 'metadata': {
            const next = { ...answers, metadata: action.metadata }
            return stays(action) ? { ...state, answers: next } : forward(state, next, cursor + 1)
        }
        case 'when': {
            const next: Answers = {
                ...answers,
                when: action.when,
                schedule:
                    answers.schedule ?? (action.when === 'schedule' ? DEFAULT_WHEN : undefined),
            }
            return stays(action) ? { ...state, answers: next } : forward(state, next, cursor + 1)
        }
        case 'keep': {
            const next = { ...answers, keep: action.keep }
            return stays(action) ? { ...state, answers: next } : forward(state, next, cursor + 1)
        }
        case 'set':
            return { ...state, answers: { ...answers, ...action.patch } }
        case 'next':
            return forward(state, answers, cursor + 1)
        case 'back': {
            if (state.editing) return { answers: state.editing, cursor: planIndex(state.editing) }
            return cursor <= 1 ? INITIAL : { ...state, cursor: cursor - 1 }
        }
        case 'goto': {
            const index = stepsFor(answers).indexOf(action.step)
            return index < 0 ? state : { answers, cursor: index, editing: answers }
        }
        case 'reset':
            return INITIAL
    }
}

/**
 * The Wizard ("Run" in the launcher): plain questions that lead to an operation, and a
 * plan that opens its page filled in. See flow.ts.
 */
export default function Wizard() {
    const [key] = useState(() => stateKey(dataDir()))
    const [state, dispatch] = useReducer(reducer, key, loadState)
    useEffect(() => saveState(key, state), [key, state])
    const { answers, cursor, editing } = state
    const { serveTypes } = useFlags()
    const os = platform()
    const questionId = useId()
    const steps = stepsFor(answers)
    const step = steps[Math.min(cursor, steps.length - 1)]
    const operation = operationFor(answers)
    const total = answers.goal ? stepCount(answers.goal) : undefined

    // A pick unmounts the button that had focus, so focus moves to the next question, where
    // keyboard users expect it.
    const heading = useRef<HTMLHeadingElement>(null)
    // biome-ignore lint/correctness/useExhaustiveDependencies: `step` is the trigger, not an input
    useEffect(() => {
        heading.current?.focus({ preventScroll: true })
    }, [step])

    // The core's check of a schedule's time, as the When field shows it, holds Continue.
    const cron = step === 'when' ? cronFor(answers) : undefined
    // An answer about an earlier time is ignored, so it never holds Continue.
    const { described, description } = useWhenDescription(cron ?? '')
    const cronProblem =
        cron && cron === described && !description.isPlaceholderData
            ? (description.data?.problem ?? undefined)
            : undefined

    const info = infoFor(step, answers, os)

    const set = (patch: Partial<Answers>) => dispatch({ type: 'set', patch })
    const setSources = (sources: string[] | undefined) =>
        set({ sources: sources && sources.length > 0 ? sources : undefined })

    // Continue shows on a step already answered (to go on without changing it), and on the steps
    // that take typing.
    const revisit = (answered: boolean) => (answered && !editing ? true : undefined)

    let question: string
    let body: ReactNode
    let canContinue: boolean | undefined
    switch (step) {
        case 'goal': {
            question = GOAL_QUESTION
            body = (
                <OptionCards
                    labelledBy={questionId}
                    choices={GOALS}
                    value={answers.goal}
                    onPick={(goal) => dispatch({ type: 'goal', goal })}
                />
            )
            canContinue = revisit(!!answers.goal)
            break
        }
        case 'refine': {
            const refine = answers.goal ? refineFor(answers.goal) : undefined
            question = refine?.question ?? ''
            body = refine && (
                <OptionCards
                    labelledBy={questionId}
                    // A share offers the serve types that this rclone has (nfs isn't on Windows).
                    choices={refine.choices.filter(
                        (choice) =>
                            answers.goal !== 'share' ||
                            serveTypes.length === 0 ||
                            serveTypes.includes(choice.key)
                    )}
                    value={answers.refine}
                    onPick={(refine) => dispatch({ type: 'refine', refine })}
                />
            )
            canContinue = revisit(!!answers.refine)
            break
        }
        case 'places': {
            const places = operation ? placesFor(operation) : undefined
            question = places?.question ?? ''
            const fields = places?.fields ?? []
            const tone = operation ? OPERATION_TONE[operation] : WINDOWS.wizard.tone
            body = (
                <RoutePanel tone={tone}>
                    {fields.map(({ key, label, picker }, index) => {
                        const stop = fields.length === 1 ? 'single' : index === 0 ? 'from' : 'to'
                        let field: ReactNode
                        if (key === 'url') {
                            field = (
                                <Input
                                    size="lg"
                                    type="url"
                                    label={label}
                                    placeholder="https://…"
                                    value={answers.url ?? ''}
                                    onValueChange={(url) => set({ url })}
                                    isClearable={true}
                                    onClear={() => set({ url: '' })}
                                    classNames={bareField()}
                                    autoComplete="off"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                />
                            )
                        } else if (key === 'sources' && picker?.many) {
                            // The pickers are the operation page's: several paths where it takes
                            // several, and files where it takes files.
                            field = (
                                <MultiPathField
                                    paths={answers.sources ?? []}
                                    setPaths={setSources}
                                    label={label}
                                    allowedKeys={picker.allowedKeys}
                                    showFiles={picker.files}
                                    remember={picker.remember}
                                    bare={true}
                                />
                            )
                        } else {
                            const mountPoint = operation === 'mount' && key === 'destination'
                            field = (
                                <PathField
                                    path={
                                        (key === 'sources'
                                            ? answers.sources?.[0]
                                            : answers.destination) ?? ''
                                    }
                                    setPath={(value) =>
                                        key === 'sources'
                                            ? setSources(value ? [value] : undefined)
                                            : set({ destination: value })
                                    }
                                    label={label}
                                    allowedKeys={picker?.allowedKeys}
                                    showFiles={picker?.files ?? false}
                                    remember={picker?.remember}
                                    // A mount point on Windows can be a drive letter.
                                    problemOf={
                                        mountPoint
                                            ? (path) =>
                                                  isDrive(path, os === 'windows')
                                                      ? undefined
                                                      : pathProblem(path)
                                            : undefined
                                    }
                                    bare={true}
                                />
                            )
                        }
                        return (
                            <div key={key}>
                                {index > 0 && <RouteLink tone={tone} />}
                                <RouteRow stop={stop} tone={tone} filled={operation === 'bisync'}>
                                    {field}
                                </RouteRow>
                            </div>
                        )
                    })}
                </RoutePanel>
            )
            canContinue = stepComplete('places', answers)
            break
        }
        case 'metadata': {
            question = METADATA_QUESTION
            body = (
                <>
                    <OptionCards
                        labelledBy={questionId}
                        choices={METADATAS}
                        value={answers.metadata}
                        onPick={(metadata) => dispatch({ type: 'metadata', metadata })}
                    />
                    {answers.metadata === 'map' && (
                        <MetadataMapper
                            value={answers.mapper ?? ''}
                            onChange={(mapper) =>
                                set({ mapper: mapper === '' ? undefined : mapper })
                            }
                            paths={{
                                source: answers.sources?.[0],
                                destination: answers.destination,
                            }}
                        />
                    )}
                </>
            )
            canContinue =
                answers.metadata === 'map'
                    ? stepComplete('metadata', answers)
                    : revisit(!!answers.metadata)
            break
        }
        case 'when': {
            question = WHEN_QUESTION
            const schedule = answers.schedule ?? DEFAULT_WHEN
            body = (
                <>
                    <OptionCards
                        labelledBy={questionId}
                        choices={WHENS}
                        value={answers.when}
                        onPick={(when) => dispatch({ type: 'when', when })}
                    />
                    {answers.when === 'schedule' && (
                        <WhenField
                            when={schedule}
                            cron={toCron(schedule)}
                            onChange={(next) => set({ schedule: { ...schedule, ...next } })}
                        />
                    )}
                </>
            )
            canContinue =
                answers.when === 'schedule'
                    ? stepComplete('when', answers, cronProblem)
                    : revisit(!!answers.when)
            break
        }
        case 'keep': {
            question = KEEP_QUESTION
            body = (
                <>
                    <OptionCards
                        labelledBy={questionId}
                        choices={KEEPS}
                        value={answers.keep}
                        onPick={(keep) => dispatch({ type: 'keep', keep })}
                    />
                    {answers.keep === 'template' && (
                        <Input
                            size="lg"
                            label={t`Template name`}
                            autoFocus={true}
                            value={answers.templateName ?? ''}
                            onValueChange={(templateName) => set({ templateName })}
                            autoComplete="off"
                            spellCheck="false"
                        />
                    )}
                </>
            )
            canContinue =
                answers.keep === 'template'
                    ? stepComplete('keep', answers)
                    : revisit(!!answers.keep)
            break
        }
        default: {
            question = t`Your plan`
            body = operation && (
                <Plan
                    answers={answers}
                    steps={steps}
                    onChange={(target) => dispatch({ type: 'goto', step: target })}
                />
            )
        }
    }

    const back = editing ? t`Back to plan` : cursor > 0 ? t`Back` : undefined
    const segments = sentence(answers)
    const goal = GOALS.find((choice) => choice.key === answers.goal)
    // The tile shows where the answers lead: the operation's window once it is known.
    const look: Pick<WindowLook, 'icon' | 'tone'> = operation
        ? WINDOWS[operation]
        : goal?.icon && goal.tone
          ? { icon: goal.icon, tone: goal.tone }
          : WINDOWS.wizard
    const index = steps.indexOf(step)
    const count = operation ? steps.length : total
    const number = index + 1
    const where = editing
        ? t`Changing your plan`
        : count
          ? t`Step ${number} of ${count}`
          : t`Step ${number}`
    const reset = () => dispatch({ type: 'reset' })
    const plan = usePlan(key, answers, reset)

    return (
        <div className="flex flex-col h-screen overflow-y-auto">
            <div
                className={cn(
                    'flex flex-col flex-1 w-full max-w-3xl gap-8 px-5 pt-8 pb-4 mx-auto',
                    platform() === 'macos' && 'pt-12'
                )}
            >
                <header className="flex flex-col gap-5">
                    <div className="flex items-center gap-3.5">
                        <IconTile icon={look.icon} tone={look.tone} size="xl" />
                        <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                            <p
                                className={cn(
                                    'font-semibold tracking-wider uppercase text-tiny tabular-nums',
                                    TONE_TEXT[look.tone]
                                )}
                            >
                                {where}
                            </p>
                            <h1 className="text-2xl font-semibold leading-tight tracking-tight font-rounded">
                                {WINDOWS.wizard.title}
                            </h1>
                        </div>
                    </div>
                    <Progress
                        count={count ?? stepCount('transfer')}
                        index={index}
                        tone={look.tone}
                    />
                    <p
                        aria-label={t({
                            message: 'Plan',
                            comment: 'The sentence that sums up the plan.',
                        })}
                        className="text-[15px] leading-relaxed text-default-700 text-pretty"
                    >
                        {segments.map((segment, at) => (
                            <span
                                key={`${at}-${segment.text}`}
                                className={
                                    segment.filled
                                        ? undefined
                                        : 'text-default-400 underline decoration-dashed decoration-default-300 underline-offset-4'
                                }
                            >
                                {segment.text}
                            </span>
                        ))}
                    </p>
                </header>

                {/* A form, so that Enter in a text field moves on, as Continue does. */}
                <form
                    aria-labelledby={questionId}
                    className="flex flex-col gap-5"
                    onSubmit={(event) => {
                        event.preventDefault()
                        if (canContinue) dispatch({ type: 'next' })
                    }}
                >
                    <h2
                        ref={heading}
                        id={questionId}
                        tabIndex={-1}
                        className="text-xl font-semibold tracking-tight outline-none text-balance"
                    >
                        {question}
                    </h2>
                    {body}
                    {step !== 'plan' && info && <StepInfo info={info} />}
                </form>
            </div>

            {(back || canContinue !== undefined || step === 'plan') && (
                <OperationWindowFooter>
                    {back ? (
                        <Button
                            size="lg"
                            variant="flat"
                            startContent={<ArrowLeftSmallIcon className="size-5" />}
                            onPress={() => dispatch({ type: 'back' })}
                            className="font-medium text-default-700"
                            data-focus-visible="false"
                        >
                            {back}
                        </Button>
                    ) : null}
                    {step === 'plan' ? (
                        <Button
                            size="lg"
                            variant="light"
                            onPress={reset}
                            isDisabled={plan.opening}
                            className="font-medium text-default-600"
                            data-focus-visible="false"
                        >
                            <Trans>Start over</Trans>
                        </Button>
                    ) : null}
                    <span className="flex-1" />
                    {step === 'plan' && plan.label ? (
                        <Button
                            size="lg"
                            color="primary"
                            isLoading={plan.opening}
                            onPress={plan.open}
                            endContent={
                                plan.opening ? undefined : (
                                    <ArrowRightSmallIcon className="size-5" />
                                )
                            }
                            className={cn('gap-2 px-5 font-semibold', toneButton(look.tone))}
                            data-focus-visible="false"
                        >
                            {plan.label}
                        </Button>
                    ) : canContinue === undefined ? null : (
                        <Button
                            size="lg"
                            color="primary"
                            isDisabled={!canContinue}
                            onPress={() => dispatch({ type: 'next' })}
                            endContent={<ArrowRightSmallIcon className="size-5" />}
                            className={cn(
                                'gap-2 px-5 font-semibold min-w-32',
                                toneButton(look.tone)
                            )}
                            data-focus-visible="false"
                        >
                            {editing ? t`Done` : t`Continue`}
                        </Button>
                    )}
                </OperationWindowFooter>
            )}
        </div>
    )
}

function Progress({
    count,
    index,
    tone,
}: {
    count: number
    index: number
    tone: keyof typeof TONE_GRADIENT
}) {
    const segments = Math.max(count, index + 1)
    return (
        <div
            role="progressbar"
            aria-label={t`Steps`}
            aria-valuemin={1}
            aria-valuemax={segments}
            aria-valuenow={index + 1}
            className="flex gap-1.5"
        >
            {Array.from({ length: segments }, (_, at) => (
                <span
                    // The segments are positions, which never move.
                    key={at}
                    className={cn(
                        'h-1.5 flex-1 rounded-full transition-colors duration-300',
                        at <= index
                            ? `bg-linear-to-r ${TONE_GRADIENT[tone]}`
                            : 'bg-default-200/80 dark:bg-default-100'
                    )}
                />
            ))}
        </div>
    )
}

/**
 * Opening the plan: it saves the template, if one was asked for, opens the operation's page with
 * the answers, clears the Wizard and closes it.
 */
function usePlan(storageKey: string, answers: Answers, onReset: () => void) {
    const [opening, setOpening] = useState(false)
    const operation = operationFor(answers)
    const template = templateFor(answers)
    const label = operation && openLabel(operation, !!template)

    const open = async () => {
        const route = routeFor(answers)
        if (!route || opening) return
        setOpening(true)
        try {
            if (template) await saveTemplate({ id: crypto.randomUUID(), ...template })
            await openWindow(route)
        } catch (failure) {
            setOpening(false)
            await reportError(failure, {
                title: t`Couldn't open the operation`,
                fallback: template
                    ? t`The template could not be saved.`
                    : t`The operation’s page could not be opened.`,
                log: ['[Wizard] plan not opened'],
            })
            return
        }
        // The plan is on its page now, so the Wizard starts afresh next time.
        saveState(storageKey, INITIAL)
        onReset()
        await currentWindow.close()
    }

    return { opening, open, label }
}

function openLabel(operation: Operation, saving: boolean): string {
    switch (operation) {
        case 'copy':
            return saving ? t`Open Copy and save template` : t`Open Copy`
        case 'move':
            return saving ? t`Open Move and save template` : t`Open Move`
        case 'sync':
            return saving ? t`Open Sync and save template` : t`Open Sync`
        case 'bisync':
            return saving ? t`Open Bisync and save template` : t`Open Bisync`
        case 'mount':
            return saving ? t`Open Mount and save template` : t`Open Mount`
        case 'serve':
            return saving ? t`Open Serve and save template` : t`Open Serve`
        case 'download':
            return t`Open Download`
        case 'delete':
            return saving ? t`Open Delete and save template` : t`Open Delete`
        case 'purge':
            return saving ? t`Open Purge and save template` : t`Open Purge`
    }
}

function Plan({
    answers,
    steps,
    onChange,
}: {
    answers: Answers
    steps: StepKey[]
    onChange: (step: StepKey) => void
}) {
    const operation = operationFor(answers)
    if (!operation) return null
    const label = OPERATION_LABEL[operation]
    const Icon = OPERATION_ICON[operation]
    const fields = placesFor(operation).fields
    const template = templateFor(answers)
    const info: Info | undefined = infoFor('plan', answers, platform())

    const rows: {
        key: string
        label: string
        value: ReactNode
        step: StepKey
        /** The Change button's name for a screen reader. */
        change: string
    }[] = [
        {
            key: 'operation',
            label: t`Operation`,
            change: t`Change the operation`,
            value: (
                <span className="inline-flex items-center gap-2.5 font-medium">
                    <IconTile icon={Icon} tone={OPERATION_TONE[operation]} size="sm" />
                    {label}
                </span>
            ),
            step: 'goal',
        },
        ...fields.map((field) => {
            const paths = pathsOf(answers, field.key)
            return {
                key: field.key,
                label: field.label,
                change: t`Change the places`,
                value: (
                    <span title={paths.join('\n')} className="font-mono text-small">
                        {field.kind === 'url' ? paths[0] : placesPhrase(paths)}
                    </span>
                ),
                step: 'places' as const,
            }
        }),
    ]
    if (steps.includes('metadata')) {
        rows.push({
            key: 'metadata',
            label: t`Metadata`,
            change: t`Change the metadata`,
            value: metadataPhrase(answers) ?? '',
            step: 'metadata',
        })
    }
    if (steps.includes('when')) {
        rows.push({
            key: 'when',
            label: t({ message: 'When', comment: 'In the plan: when the operation runs.' }),
            change: t`Change when it runs`,
            value: whenPhrase(answers) ?? '',
            step: 'when',
        })
    }
    if (steps.includes('keep')) {
        rows.push({
            key: 'keep',
            label: t`Template`,
            change: t`Change the template`,
            value: template?.name ?? t`Not saved`,
            step: 'keep',
        })
    }

    return (
        <div className="flex flex-col gap-5">
            <Panel>
                <dl className="flex flex-col divide-y divide-divider">
                    {rows.map((row) => (
                        <div key={row.key} className="flex items-center gap-4 py-2.5 pl-4 pr-2.5">
                            <dt className="w-40 text-small shrink-0 text-default-500 text-pretty">
                                {row.label}
                            </dt>
                            <dd className="flex-1 min-w-0 truncate">{row.value}</dd>
                            <Button
                                size="sm"
                                variant="light"
                                className="shrink-0 text-default-500"
                                onPress={() => onChange(row.step)}
                                aria-label={row.change}
                            >
                                <Trans comment="Button: goes back to the step of this answer, to change it.">
                                    Change
                                </Trans>
                            </Button>
                        </div>
                    ))}
                </dl>
            </Panel>
            {info && <StepInfo info={info} label={t`What happens next`} />}
        </div>
    )
}
