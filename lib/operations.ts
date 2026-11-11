// The operations that the core runs (core/operations), and the form that carries one of them with
// its arguments. The core's Operation is an enum, so a list of operations names them by their
// values here, and operationOf is the one place that turns a name back into the enum.

import type { Operations } from './core/types'

/** An operation's name, such as 'copy' or 'delete-folder'. */
export type OperationName = Exclude<`${Operations.Operation}`, ''>

/**
 * Some of the operations, by name. A name that isn't an operation's fails to compile, so a list
 * of operations can't drift from the core's.
 */
export type OperationSubset<T extends OperationName> = T

/** The field of a form that holds an operation's arguments. Only delete-folder's is renamed. */
type FieldOf<O extends OperationName> = O extends 'delete-folder' ? 'deleteFolder' : O

/** The arguments of an operation, as its field of a form holds them. */
export type ArgsOf<O extends OperationName> = NonNullable<Operations.Form[FieldOf<O>]>

function fieldOf<O extends OperationName>(operation: O): FieldOf<O> {
    return (operation === 'delete-folder' ? 'deleteFolder' : operation) as FieldOf<O>
}

/** The core's enum value of an operation's name. Each name is one of the enum's values. */
export function operationOf(operation: OperationName): Operations.Operation {
    return operation as Operations.Operation
}

export function formOf<O extends OperationName>(operation: O, args: ArgsOf<O>): Operations.Form {
    return { operation: operationOf(operation), [fieldOf(operation)]: args }
}

/** The arguments of a form, whatever its operation, or undefined when it has none. */
export function formArgs(
    form: Operations.Form | null | undefined
): ArgsOf<OperationName> | undefined {
    if (!form?.operation) return undefined
    return argsOf(form, form.operation as OperationName)
}

/** The arguments of a form, when it is a form of `operation`. */
export function argsOf<O extends OperationName>(
    form: Operations.Form | null | undefined,
    operation: O
): ArgsOf<O> | undefined {
    if (form?.operation !== operation) return undefined
    return (form[fieldOf(operation)] ?? undefined) as ArgsOf<O> | undefined
}

/**
 * The sources and the destination of a form, as the core's Form.Ends gives them for a form that a
 * page fills in: `sources`, or the one `source`, and `destination`. Blank sources are left out.
 */
export function endsOf(form: Operations.Form | null | undefined): {
    sources: string[]
    destination: string
} {
    const args = formArgs(form)
    if (!args) return { sources: [], destination: '' }
    const sources =
        'sources' in args
            ? (args.sources ?? [])
            : 'source' in args && args.source
              ? [args.source]
              : []
    const destination = 'destination' in args ? (args.destination ?? '') : ''
    return { sources: sources.filter(Boolean), destination }
}

/** The option groups of a form, or undefined when its operation has none. */
export function groupsOf(form: Operations.Form | null | undefined): Operations.Groups | undefined {
    const args = formArgs(form)
    return args && 'options' in args ? (args.options ?? undefined) : undefined
}
