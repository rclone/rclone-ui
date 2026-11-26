import { Tab, Tabs } from '@heroui/react'
import { type UseQueryResult, useQueries } from '@tanstack/react-query'
import { type Dispatch, type SetStateAction, useMemo } from 'react'
import { backendQuery } from '../../lib/catalog'
import type { Catalog } from '../../lib/core/types'
import { remoteConfigQuery } from '../../lib/remotes'
import OptionGroupEditor from '../components/OptionGroupEditor'

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

const configsOf = (results: UseQueryResult<Record<string, string>>[]) => results.map((r) => r.data)

const backendOptionsOf = (results: UseQueryResult<Catalog.BackendOptions | null>[]) =>
    results.map((r) => (r.isPending ? undefined : (r.data?.backend?.options ?? [])))

export default function RemoteOptionsEditor({
    remoteNames,
    remoteOptionsJson,
    setRemoteOptionsJson,
}: {
    remoteNames: readonly string[]
    remoteOptionsJson: Record<string, string>
    setRemoteOptionsJson: Dispatch<SetStateAction<Record<string, string>>>
}) {
    const remoteConfigs = useQueries({
        queries: remoteNames.map(remoteConfigQuery),
        combine: configsOf,
    })

    const backendOptions = useQueries({
        queries: remoteConfigs.map((config) => backendQuery(config?.type, config?.provider)),
        combine: backendOptionsOf,
    })

    const tabItems = useMemo(
        () =>
            remoteNames
                .map((name, i) => {
                    const config = remoteConfigs[i]
                    const options = backendOptions[i]
                    if (!config || !options) return null
                    return {
                        id: name,
                        label: name.toUpperCase(),
                        options: options.filter(
                            (o) =>
                                !IGNORED_OPTIONS.includes(o.name) &&
                                !!o.help &&
                                !o.password &&
                                !o.sensitive
                        ),
                        config,
                    }
                })
                .filter((item) => item !== null),
        [remoteNames, remoteConfigs, backendOptions]
    )

    const setOptionsJsonByRemote = useMemo(() => {
        const map: Record<string, (json: string) => void> = {}
        for (const name of remoteNames) {
            map[name] = (json: string) =>
                setRemoteOptionsJson((prev) => ({
                    ...prev,
                    [name]: json,
                }))
        }
        return map
    }, [remoteNames, setRemoteOptionsJson])

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
                    <OptionGroupEditor
                        optionsJson={remoteOptionsJson[item.id] ?? '{}'}
                        setOptionsJson={setOptionsJsonByRemote[item.id]}
                        globalOptions={item.config}
                        availableOptions={item.options}
                    />
                </Tab>
            )}
        </Tabs>
    )
}
