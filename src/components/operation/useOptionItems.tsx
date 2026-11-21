import { type ReactNode, useMemo } from 'react'
import { useFlags } from '../../../lib/catalog'
import OptionGroupEditor from '../OptionGroupEditor'
import RemoteOptionsEditor from '../RemoteOptionsEditor'
import type { OptionsAccordionItemDef } from './OptionsAccordion'
import { type GroupKey, OPTION_GROUPS } from './optionGroups'
import type { OptionGroups } from './useOptionGroups'

/**
 * The accordion rows of the option groups that useOptionGroups holds: one for each group, in the
 * order the page listed them, and then the Remotes row while the paths name a remote. Each row
 * has the group's editor, with the options that the catalog offers for it (OPTION_GROUPS).
 *
 * - `refusals`: the core's refusal of each group, which the editor shows under its text.
 * - `errors`: a message under a group's editor, such as a drawer's refusal of a save.
 * - `onEdit`: called after the user changes a group's text, so a drawer can clear its error.
 * - `mapperPaths`: the paths that the metadata mapper suggests each backend's fields for.
 * - `serveType`: the serve whose options the serve group offers. Without one, it offers the
 *   options of every serve type.
 * - `above`: what a group's row shows above its editor, such as Bisync's switches.
 * - `counted`: options that a group's title counts with its own, such as the switches that are on.
 */
export function useOptionItems<K extends GroupKey>(
    state: Pick<OptionGroups<K>, 'keys' | 'groups' | 'remoteNames' | 'remotes'>,
    {
        refusals,
        errors,
        onEdit,
        mapperPaths,
        serveType,
        above,
        counted,
    }: {
        refusals?: Readonly<Record<string, string>>
        errors?: Partial<Record<K, string>>
        onEdit?: (key: K) => void
        mapperPaths?: { source?: string; destination?: string }
        serveType?: string
        above?: Partial<Record<K, ReactNode>>
        counted?: Partial<Record<K, Record<string, unknown>>>
    } = {}
): OptionsAccordionItemDef[] {
    const flags = useFlags()
    const { keys, groups, remoteNames, remotes } = state
    // The paths are read one by one, so a page can pass a new object on each render. Without
    // them, as in the template drawer, the mapper doesn't ask for paths.
    const hasMapperPaths = mapperPaths !== undefined
    const mapperSource = mapperPaths?.source
    const mapperDestination = mapperPaths?.destination

    return useMemo(() => {
        const items: OptionsAccordionItemDef[] = keys.map((key) => {
            const group = groups[key]
            const { category, available, global } = OPTION_GROUPS[key]
            const metadata = key === 'metadata'
            const editor = (
                <OptionGroupEditor
                    key={key}
                    globalOptions={global(flags, serveType)}
                    optionsJson={group.jsonString}
                    setOptionsJson={
                        onEdit
                            ? (value) => {
                                  group.setJsonString(value)
                                  onEdit(key)
                              }
                            : group.setJsonString
                    }
                    availableOptions={available(flags, serveType)}
                    mapperPaths={
                        metadata && hasMapperPaths
                            ? { source: mapperSource, destination: mapperDestination }
                            : undefined
                    }
                    // A page with a Remotes section lets the mapper point there for this run.
                    mapperRemoteOverrides={metadata && remoteNames ? remotes.options : undefined}
                    refusal={refusals?.[key]}
                />
            )
            const error = errors?.[key]
            return {
                key,
                category,
                options: counted?.[key] ? { ...counted[key], ...group.options } : group.options,
                children: errors ? (
                    <div className="flex flex-col gap-1">
                        {editor}
                        {error && <p className="px-1 text-tiny text-danger">{error}</p>}
                    </div>
                ) : (
                    <>
                        {above?.[key]}
                        {editor}
                    </>
                ),
            }
        })
        if (remoteNames && remoteNames.length > 0) {
            items.push({
                key: 'remotes',
                category: 'remotes',
                options: remotes.options,
                children: (
                    <RemoteOptionsEditor
                        remoteNames={remoteNames}
                        remoteOptionsJson={remotes.json}
                        setRemoteOptionsJson={remotes.setJson}
                    />
                ),
            })
        }
        return items
    }, [
        keys,
        groups,
        remoteNames,
        remotes,
        flags,
        refusals,
        errors,
        onEdit,
        hasMapperPaths,
        mapperSource,
        mapperDestination,
        serveType,
        above,
        counted,
    ])
}
