import { Tab, Tabs } from '@heroui/react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef } from 'react'
import { getRemoteName } from '@/lib/format'
import { backendsQueryOptions, remoteConfigQueryOptions } from '@/lib/hooks'
import OptionsSection from '@/components/OptionsSection'

const IGNORED_OPTIONS = [
    'account',
    'key',
    'endpoint',
    'description',
    'provider',
    'env_auth',
    'region',
    'acl',
    'access_key_id',
    'secret_access_key',
    'location_constraint',
    'sse_kms_key_id',
    'sse_customer_key',
    'sse_customer_algorithm',
    'sse_customer_key_base64',
    'sse_customer_key_md5',
]

// Pure view over the remotes option state owned by useOptionGroups: each tab renders the raw
// per-remote JSON doc and writes through; parsing/retention/reset semantics live in the hook.
export default function RemoteOptionsSection({
    selectedRemotes,
    remoteOptionsLocked,
    remoteOptionsJson,
    setRemoteOptionsJson,
    reconcileRemotes,
    setRemoteOptionsLocked,
}: {
    selectedRemotes: string[]
    remoteOptionsLocked: boolean
    remoteOptionsJson: Record<string, string>
    setRemoteOptionsJson: Dispatch<SetStateAction<Record<string, string>>>
    reconcileRemotes: (remoteNames: string[], force?: boolean) => void
    setRemoteOptionsLocked: (value: boolean) => void
}) {
    const backendsQuery = useQuery({
        ...backendsQueryOptions(),
        experimental_prefetchInRender: true,
    })

    const backends = useMemo(() => backendsQuery.data ?? [], [backendsQuery.data])

    const remoteNamesQueries = useQueries({
        queries: selectedRemotes.map((remote) => ({
            queryKey: ['remote', remote, 'name'],
            queryFn: () => getRemoteName(remote),
        })),
    })

    const uniqueRemotes = useMemo(
        () =>
            Array.from(
                remoteNamesQueries.reduce((acc, curr) => {
                    if (curr.data) {
                        acc.add(curr.data)
                    }
                    return acc
                }, new Set<string>())
            ),
        [remoteNamesQueries]
    )

    const remoteConfigQueries = useQueries({
        queries: uniqueRemotes.map((remote) => remoteConfigQueryOptions(remote)),
    })

    const remoteConfigs = useMemo(
        () =>
            remoteConfigQueries
                .map((query, i) => ({ name: uniqueRemotes[i], config: query.data }))
                .map((data) => {
                    const { config, name } = data
                    if (!config) return null

                    if (config.type === 's3') {
                        if (config.provider) {
                            const backendOptions =
                                backends.find((b) => b.Name === config.type)?.Options || []
                            const providerOptions = backendOptions
                                .filter(
                                    (o) =>
                                        (!o.Provider || o.Provider.includes(config.provider!)) &&
                                        !IGNORED_OPTIONS.includes(o.Name) &&
                                        !!o.Help
                                )
                                .map((o) => ({ ...o, FieldName: o.Name }))
                                .filter(Boolean)
                            console.log('[RemoteOptionsSection] providerOptions', providerOptions)
                            return {
                                name,
                                config,
                                options: providerOptions,
                            }
                        }
                        return null
                    }

                    return {
                        name,
                        config,
                        options: [
                            ...(backends.find((b) => b.Name === config.type)?.Options || [])
                                .filter((o) => !IGNORED_OPTIONS.includes(o.Name) && !!o.Help)
                                .map((o) => ({ ...o, FieldName: o.Name }))
                                .filter(Boolean),
                        ],
                    }
                })
                .filter(Boolean),
        [remoteConfigQueries, backends, uniqueRemotes]
    )

    // Report the current unique remote names so the hook can rebuild the tab strings when the
    // remote count changes (prune on deselect, seed on addition, discard mid-edit invalid text).
    // The first call after (re)mounting forces the rebuild: the old per-tab strings were child
    // state destroyed on unmount, so a remount always rebuilt every tab from the last-valid doc.
    const isFirstReconcile = useRef(true)
    useEffect(() => {
        reconcileRemotes(uniqueRemotes, isFirstReconcile.current)
        isFirstReconcile.current = false
    }, [uniqueRemotes, reconcileRemotes])

    const tabItems = useMemo(
        () =>
            remoteConfigs.map((data) => ({
                id: data.name,
                label: data.name.toUpperCase(),
                options: data.options,
                config: data.config,
            })),
        [remoteConfigs]
    )

    const setOptionsJsonByRemote = useMemo(() => {
        const map: Record<string, (json: string) => void> = {}
        for (const data of remoteConfigs) {
            map[data.name] = (json: string) =>
                setRemoteOptionsJson((prev) => ({
                    ...prev,
                    [data.name]: json,
                }))
        }
        return map
    }, [remoteConfigs, setRemoteOptionsJson])

    return (
        <Tabs
            items={tabItems}
            fullWidth={true}
            variant="bordered"
            destroyInactiveTabPanel={false}
            size="sm"
        >
            {(item) => (
                <Tab key={item.id} title={item.label}>
                    <OptionsSection
                        optionsJson={remoteOptionsJson[item.id] ?? '{}'}
                        setOptionsJson={setOptionsJsonByRemote[item.id]}
                        globalOptions={item.config}
                        availableOptions={item.options}
                        isLocked={remoteOptionsLocked}
                        setIsLocked={setRemoteOptionsLocked}
                    />
                </Tab>
            )}
        </Tabs>
    )
}
