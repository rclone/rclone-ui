import { useQuery } from '@tanstack/react-query'
import { templates as api } from './core/api'
import { coreKey } from './core/query'
import type { Operations, Templates } from './core/types'
import { type OperationSubset, operationOf } from './operations'

export type Template = Templates.Template

/** The operations that a template can be for. The core sends the same list with the templates. */
export type TemplateTag = OperationSubset<
    'copy' | 'move' | 'sync' | 'bisync' | 'delete' | 'purge' | 'mount' | 'serve'
>

/**
 * A template's tags by name. The core keeps only the tags that it lists in List.tags, which are
 * all TemplateTags.
 */
export function tagNames(tags: readonly Operations.Operation[]): TemplateTag[] {
    return tags as readonly string[] as TemplateTag[]
}

const NONE: Template[] = []
const NO_TAGS: Operations.Operation[] = []

/**
 * Returns every template in list order, and every tag that a template can have, along with the
 * list's query, so that callers can tell a list that didn't load from an empty one.
 * templates.changed keeps it fresh.
 */
export function useTemplateList() {
    const query = useQuery({ queryKey: coreKey('templates', 'List'), queryFn: () => api.List() })
    return {
        templates: query.data?.templates ?? NONE,
        tags: query.data?.tags ?? NO_TAGS,
        query,
    }
}

export function useTemplates(): Template[] {
    return useTemplateList().templates
}

/**
 * Saves a template. A new id adds it, and an existing id replaces it. The core drops blank
 * sources and trims the destination, and keeps no paths when none is left.
 */
export function saveTemplate(t: Template): Promise<Template> {
    return api.Save(t)
}

export function deleteTemplates(ids: string[]): Promise<number> {
    return api.DeleteMany(ids)
}

/**
 * The options of the template saved under `id`, sorted by the core into the groups of
 * `operation`'s form, as its page applies them. `serveType` is the Serve page's type, or '' for
 * every type. The options that the form leaves out come back as skipped.
 */
export function templateGroups(
    id: string,
    operation: TemplateTag,
    serveType = ''
): Promise<Templates.Applied> {
    return api.Groups(id, operationOf(operation), serveType)
}

/**
 * The export file of the templates with the given ids, as the core writes it: each template's
 * name, options and paths, and its options as a command line for this computer's shell.
 */
export function exportTemplates(ids: string[]): Promise<string> {
    return api.Export(ids)
}
