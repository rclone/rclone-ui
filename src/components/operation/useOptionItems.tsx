import { type ReactNode, useMemo } from 'react'
import { useFlags } from '../../../lib/catalog'
import OptionGroupEditor from '../OptionGroupEditor'
import RemoteOptionsEditor from '../RemoteOptionsEditor'
import type { OptionsAccordionItemDef } from './OptionsAccordion'
import { type GroupKey, OPTION_GROUPS } from './optionGroups'
import type { OptionGroups } from './useOptionGroups'

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
