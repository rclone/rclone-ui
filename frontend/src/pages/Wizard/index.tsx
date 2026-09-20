import { Button, Input, cn } from '@heroui/react'
import { ArrowLeftIcon, RotateCcwIcon } from 'lucide-react'
import { type ReactNode, useEffect, useId, useReducer, useRef } from 'react'
import { buildReadablePath } from '@/lib/format'
import { currentHostOs } from '@/lib/rclone/client'
import MetadataMapper from '@/components/MetadataMapper'
import { OPERATIONS } from '@/components/OperationGrid'
import { PathField } from '@/components/PathFinder'
import { CronSection } from '@/components/CronEditor'
import { openOperation } from '@/components/operation/useOperationPreset'
import { Eyebrow } from '@/pages/Dashboard/primitives'
import OptionCards, { TONE_TEXT } from './OptionCards'
import StepInfo from './StepInfo'
import {
    type Answers,
    GOALS,
    GOAL_QUESTION,
    type Goal,
    KEEPS,
    KEEP_QUESTION,
    type Keep,
    METADATAS,
    METADATA_QUESTION,
    type Metadata,
    OPERATION_TONE,
    type Refine,
    type StepKey,
    WHENS,
    WHEN_QUESTION,
    type When,
    infoFor,
    metadataPhrase,
    operationFor,
    placesFor,
    planReady,
    presetFromAnswers,
    refineFor,
    sentence,
    stepComplete,
    stepCount,
    stepsFor,
    whenPhrase,
} from './flow'

interface State {
    answers: Answers
    cursor: number
    /** The plan as it was when Change was pressed; set while one answer is being changed. */
    editing?: Answers
}

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

const INITIAL: State = { answers: {}, cursor: 0 }

const planIndex = (answers: Answers) => stepsFor(answers).length - 1

/** The three picks that open a field on their own step instead of moving on. */
const stays = (action: Action) =>
    (action.type === 'metadata' && action.metadata === 'map') ||
    (action.type === 'when' && action.when === 'custom') ||
    (action.type === 'keep' && action.keep === 'template')

// A forward move: straight back to the plan while an answer is being changed and the path is
// complete, otherwise to `cursor`. Arriving at the plan ends the change (no `editing` here).
function forward(state: State, answers: Answers, cursor: number): State {
    return state.editing && planReady(answers)
        ? { answers, cursor: planIndex(answers) }
        : { ...state, answers, cursor }
}

// A choice advances by itself; the steps that take typing wait for Continue. "Yes, with
// changes", "Custom" and "Save as a template" open a field on their own step, so they wait too.
// Back keeps the answers, except onto step 1, which is always a fresh start.
// Change on the plan snapshots the plan into `editing`: a pick or Done returns to it, and
// "Back to plan" restores the snapshot untouched.
function reducer(state: State, action: Action): State {
    const { answers, cursor } = state
    switch (action.type) {
        case 'goal': {
            // A different goal is a different path: the answers after it no longer apply.
            if (answers.goal !== action.goal) return { answers: { goal: action.goal }, cursor: 1 }
            // The same goal again: on to its second question, or (mount, download) the plan.
            return refineFor(action.goal) ? { ...state, cursor: 1 } : forward(state, answers, 1)
        }
        case 'refine':
            return forward(state, { ...answers, refine: action.refine }, cursor + 1)
        case 'metadata': {
            const next = { ...answers, metadata: action.metadata }
            return stays(action) ? { ...state, answers: next } : forward(state, next, cursor + 1)
        }
        case 'when': {
            const next = { ...answers, when: action.when }
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
        case 'back':
            if (state.editing) return { answers: state.editing, cursor: planIndex(state.editing) }
            return cursor <= 1 ? INITIAL : { ...state, cursor: cursor - 1 }
        case 'goto': {
            const index = stepsFor(answers).indexOf(action.step)
            return index < 0 ? state : { answers, cursor: index, editing: answers }
        }
        case 'reset':
            return INITIAL
    }
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * Plain questions that lead to an rclone operation: what to do, where, when, and whether to keep
 * the settings. The sentence at the top reads the plan back as it fills in; the last step hands
 * the plan to the operation's page.
 */
export default function Wizard() {
    const [{ answers, cursor, editing }, dispatch] = useReducer(reducer, INITIAL)
    const questionId = useId()
    const steps = stepsFor(answers)
    const step = steps[Math.min(cursor, steps.length - 1)]
    const operation = operationFor(answers)
    const operationLabel = OPERATIONS.find((entry) => entry.id === operation)?.label
    const total = answers.goal ? stepCount(answers.goal) : undefined

    // Picks unmount the button that had focus; put it on the next question so keyboard users
    // land where the wizard went.
    const heading = useRef<HTMLHeadingElement>(null)
    // biome-ignore lint/correctness/useExhaustiveDependencies: `step` is the trigger, not an input
    useEffect(() => {
        heading.current?.focus({ preventScroll: true })
    }, [step])

    const info = infoFor(step, answers, { platform: currentHostOs() })

    const setPlace = (key: 'source' | 'destination' | 'url', value: string) =>
        dispatch({ type: 'set', patch: { [key]: value } as Partial<Answers> })

    // Continue on a choice step: only after Back, when the answer is already there. Never while
    // changing an answer: a pick returns to the plan by itself, "Back to plan" is the other way.
    const revisit = (answered: boolean) => (answered && !editing ? true : undefined)

    let question: string
    let body: ReactNode
    // Undefined on the steps that advance by themselves.
    let canContinue: boolean | undefined
    switch (step) {
        case 'goal':
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
        case 'refine': {
            const refine = answers.goal ? refineFor(answers.goal) : undefined
            question = refine?.question ?? ''
            body = refine && (
                <div className="flex flex-col gap-5">
                    <OptionCards
                        labelledBy={questionId}
                        choices={refine.choices}
                        value={answers.refine}
                        onPick={(key) => dispatch({ type: 'refine', refine: key })}
                    />
                    {info && <StepInfo info={info} />}
                </div>
            )
            canContinue = revisit(!!answers.refine)
            break
        }
        case 'places': {
            const places = operation ? placesFor(operation) : undefined
            question = places?.question ?? ''
            body = (
                <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-4">
                        {places?.fields.map((field) =>
                            field.kind === 'url' ? (
                                <Input
                                    key={field.key}
                                    size="lg"
                                    type="url"
                                    label={field.label}
                                    placeholder="https://…"
                                    value={answers.url ?? ''}
                                    onValueChange={(value) => setPlace('url', value)}
                                    isClearable={true}
                                    onClear={() => setPlace('url', '')}
                                    autoComplete="off"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck="false"
                                />
                            ) : (
                                <PathField
                                    key={field.key}
                                    path={answers[field.key] ?? ''}
                                    setPath={(value) => setPlace(field.key, value)}
                                    label={field.label}
                                    allowedKeys={field.allowedKeys}
                                    showFiles={field.showFiles ?? false}
                                />
                            )
                        )}
                    </div>
                    {info && <StepInfo info={info} />}
                </div>
            )
            canContinue = stepComplete('places', answers)
            break
        }
        case 'metadata':
            question = METADATA_QUESTION
            body = (
                <div className="flex flex-col gap-5">
                    <OptionCards
                        labelledBy={questionId}
                        choices={METADATAS}
                        value={answers.metadata}
                        onPick={(metadata) => dispatch({ type: 'metadata', metadata })}
                    />
                    {answers.metadata === 'map' && (
                        <MetadataMapper
                            value={answers.mapper ?? ''}
                            // Kept only once it has a rule: an empty flag is no answer.
                            onChange={(mapper) =>
                                dispatch({
                                    type: 'set',
                                    patch: { mapper: mapper === '' ? undefined : mapper },
                                })
                            }
                            paths={{ source: answers.source, destination: answers.destination }}
                        />
                    )}
                    {info && <StepInfo info={info} />}
                </div>
            )
            canContinue =
                answers.metadata === 'map'
                    ? stepComplete('metadata', answers)
                    : revisit(!!answers.metadata)
            break
        case 'when':
            question = WHEN_QUESTION
            body = (
                <div className="flex flex-col gap-5">
                    <OptionCards
                        labelledBy={questionId}
                        choices={WHENS}
                        value={answers.when}
                        onPick={(when) => dispatch({ type: 'when', when })}
                    />
                    {answers.when === 'custom' && (
                        <CronSection
                            expression={answers.cron ?? null}
                            onChange={(cron) => dispatch({ type: 'set', patch: { cron } })}
                        />
                    )}
                    {info && <StepInfo info={info} />}
                </div>
            )
            canContinue =
                answers.when === 'custom' ? stepComplete('when', answers) : revisit(!!answers.when)
            break
        case 'keep':
            question = KEEP_QUESTION
            body = (
                <div className="flex flex-col gap-5">
                    <OptionCards
                        labelledBy={questionId}
                        choices={KEEPS}
                        value={answers.keep}
                        onPick={(keep) => dispatch({ type: 'keep', keep })}
                    />
                    {answers.keep === 'template' && (
                        <Input
                            size="lg"
                            label="Template name"
                            autoFocus={true}
                            value={answers.templateName ?? ''}
                            onValueChange={(templateName) =>
                                dispatch({ type: 'set', patch: { templateName } })
                            }
                            autoComplete="off"
                            spellCheck="false"
                        />
                    )}
                    {info && <StepInfo info={info} />}
                </div>
            )
            canContinue =
                answers.keep === 'template'
                    ? stepComplete('keep', answers)
                    : revisit(!!answers.keep)
            break
        default:
            question = 'Your plan'
            body = operation && (
                <Plan
                    answers={answers}
                    steps={steps}
                    operationLabel={operationLabel ?? operation}
                    onChange={(target) => dispatch({ type: 'goto', step: target })}
                    onReset={() => dispatch({ type: 'reset' })}
                />
            )
    }

    // The way back: to the plan while changing an answer, otherwise the previous question.
    const back = editing ? 'Back to plan' : cursor > 0 ? 'Back' : undefined

    const segments = sentence(answers)
    return (
        <div className="flex flex-col w-full max-w-2xl gap-8 px-8 py-10 mx-auto">
            <header>
                <Eyebrow>
                    {editing
                        ? 'Changing your plan'
                        : `Step ${steps.indexOf(step) + 1}${total ? ` of ${total}` : ''}`}
                </Eyebrow>
                <p aria-label="Plan" className="text-2xl font-semibold leading-snug tracking-tight">
                    {segments.map((segment, index) => (
                        <span
                            // Segments have no identity of their own; their order is the sentence.
                            key={`${index}-${segment.text}`}
                            className={
                                segment.filled
                                    ? undefined
                                    : 'font-normal text-default-400 underline decoration-dashed decoration-default-300 underline-offset-4 dark:decoration-neutral-700'
                            }
                        >
                            {segment.text}
                        </span>
                    ))}
                </p>
            </header>

            {/* A form so Enter in a text field moves on, the same as Continue. */}
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
                    className="text-base font-medium outline-none"
                >
                    {question}
                </h2>
                {body}
            </form>

            {step !== 'plan' && (
                <footer className="flex items-center justify-between">
                    {back ? (
                        <Button
                            variant="light"
                            startContent={<ArrowLeftIcon className="w-4 h-4" />}
                            onPress={() => dispatch({ type: 'back' })}
                        >
                            {back}
                        </Button>
                    ) : (
                        <span />
                    )}
                    {canContinue !== undefined && (
                        <Button
                            color="primary"
                            isDisabled={!canContinue}
                            onPress={() => dispatch({ type: 'next' })}
                        >
                            {editing ? 'Done' : 'Continue'}
                        </Button>
                    )}
                </footer>
            )}
        </div>
    )
}

// The last step: every answer on its own row, each with the way back to change it.
function Plan({
    answers,
    steps,
    operationLabel,
    onChange,
    onReset,
}: {
    answers: Answers
    steps: StepKey[]
    operationLabel: string
    onChange: (step: StepKey) => void
    onReset: () => void
}) {
    const operation = operationFor(answers)
    const Icon = OPERATIONS.find((entry) => entry.id === operation)?.icon
    const places = operation ? placesFor(operation).fields : []
    const when = whenPhrase(answers)
    const rows: { key: string; label: string; value: ReactNode; step: StepKey }[] = [
        {
            key: 'operation',
            label: 'Operation',
            value: (
                <span className="inline-flex items-center gap-2">
                    {Icon && operation && (
                        <Icon
                            className={cn('w-4 h-4', TONE_TEXT[OPERATION_TONE[operation]])}
                            strokeWidth={1.75}
                        />
                    )}
                    {operationLabel}
                </span>
            ),
            step: 'goal',
        },
        ...places.map((field) => {
            const value = answers[field.key]?.trim() ?? ''
            return {
                key: field.key,
                label: field.label,
                value: (
                    <span title={value} className="font-mono text-[13px]">
                        {field.kind === 'url' ? value : buildReadablePath(value)}
                    </span>
                ),
                step: 'places' as const,
            }
        }),
        ...(steps.includes('metadata')
            ? [
                  {
                      key: 'metadata',
                      label: 'Metadata',
                      value: metadataPhrase(answers) ?? '',
                      step: 'metadata' as const,
                  },
              ]
            : []),
        ...(steps.includes('when')
            ? [{ key: 'when', label: 'When', value: capitalize(when ?? ''), step: 'when' as const }]
            : []),
        ...(steps.includes('keep')
            ? [
                  {
                      key: 'keep',
                      label: 'Template',
                      value:
                          answers.keep === 'template'
                              ? (answers.templateName?.trim() ?? '')
                              : 'Not saved',
                      step: 'keep' as const,
                  },
              ]
            : []),
    ]

    const open = () => {
        const preset = presetFromAnswers(answers)
        if (!preset) return
        openOperation(preset)
    }

    return (
        <div className="flex flex-col gap-6">
            <dl className="border divide-y rounded-xl border-divider divide-divider dark:border-neutral-800 dark:divide-neutral-800">
                {rows.map((row) => (
                    <div key={row.key} className="flex items-center gap-4 px-4 py-3">
                        <dt className="w-40 text-xs shrink-0 text-default-500">{row.label}</dt>
                        <dd className="flex-1 min-w-0 text-sm truncate">{row.value}</dd>
                        <button
                            type="button"
                            onClick={() => onChange(row.step)}
                            className="text-xs rounded-md outline-none text-default-500 hover:text-primary focus-visible:ring-2 focus-visible:ring-primary"
                        >
                            Change
                        </button>
                    </div>
                ))}
            </dl>
            <div className="flex items-center gap-2">
                <Button color="primary" onPress={open}>
                    Open {operationLabel}
                </Button>
                <Button
                    variant="light"
                    startContent={<RotateCcwIcon className="w-4 h-4" />}
                    onPress={onReset}
                >
                    Start over
                </Button>
            </div>
        </div>
    )
}
