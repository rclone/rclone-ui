import { Button, Spinner, Textarea } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'

import { useMemo } from 'react'
import rclone from '../../../lib/rclone/client'
import { getDefaultPaths } from '../../../lib/rclone/common'
import { DOUBLE_BACKSLASH_REGEX } from '../../../lib/rclone/constants'
import { selectActiveConfigFile, useHostStore } from '../../../store/host'
import { usePersistedStore } from '../../../store/persisted'
import BaseSection from './BaseSection'
import { info as appInfo } from '../../../lib/api/app'
import { writeText } from '../../../lib/api/clipboard'
import { message } from '../../../lib/api/dialog'
import { readTail } from '../../../lib/api/fs'
import { family as type, version as osVersion } from '../../../lib/api/os'
import { appData, appLog, download, home, logFile, temp } from '../../../lib/api/paths'
import { openUrl, revealItem } from '../../../lib/api/shell'

export default function AboutSection() {
    const currentConfig = useHostStore(selectActiveConfigFile)
    const rclonePath = usePersistedStore((state) => state.rclonePath)

    const defaultPathsQuery = useQuery({
        queryKey: ['about', 'defaultPaths'],
        queryFn: async () => {
            return await getDefaultPaths()
        },
    })

    const cliVersionQuery = useQuery({
        queryKey: ['versions', 'cli', 'full'],
        queryFn: async () => await rclone('/core/version'),
    })

    const uiVersionQuery = useQuery({
        queryKey: ['versions', 'ui'],
        queryFn: async () => {
            const uiVersion = (await appInfo()).version
            return uiVersion.endsWith('.0') ? uiVersion.slice(0, -2) : uiVersion
        },
    })

    const dirsQuery = useQuery({
        queryKey: ['about', 'dirs'],
        queryFn: async () => ({
            home,
            appData,
            temp,
            appLog,
            download,
        }),
    })

    const info = useMemo(
        () => ({
            versions: {
                ...(cliVersionQuery.data ?? {}),
                ui: uiVersionQuery.data ?? '',
                osVersion,
                osFamily: type,
            },
            paths: defaultPathsQuery.data,
            dirs: dirsQuery.data,
            rcloneBinary: rclonePath,
            config: {
                id: currentConfig?.id,
                label: currentConfig?.label,
                sync: currentConfig?.sync,
                isEncrypted: currentConfig?.isEncrypted,
            },
        }),
        [
            cliVersionQuery.data,
            uiVersionQuery.data,
            currentConfig,
            defaultPathsQuery.data,
            dirsQuery.data,
            rclonePath,
        ]
    )

    const logsQuery = useQuery({
        queryKey: ['last30LogLines'],
        queryFn: async () => {
            return await readTail(logFile, 35)
        },
        enabled: !!logFile,
    })

    const jsonStringified = useMemo(
        () => (info ? JSON.stringify(info, null, 2).replace(DOUBLE_BACKSLASH_REGEX, '\\') : ''),
        [info]
    )

    return (
        <BaseSection header={{ title: 'About' }} className="-mt-2">
            {(dirsQuery.isLoading ||
                defaultPathsQuery.isLoading ||
                cliVersionQuery.isLoading ||
                uiVersionQuery.isLoading) && (
                <Spinner size="lg" color="secondary" className="py-20" />
            )}

            {info.paths && info.dirs && info.config && (
                <div className="flex flex-col px-4 gap-2.5">
                    <div className="flex flex-row justify-center w-full gap-2.5">
                        <Button
                            fullWidth={true}
                            color="primary"
                            onPress={async () => {
                                await openUrl('https://github.com/rclone-ui/rclone-ui/issues/18')
                            }}
                        >
                            Request Feature
                        </Button>
                        <Button
                            fullWidth={true}
                            color="secondary"
                            onPress={async () => {
                                if (!info.dirs?.appLog) {
                                    await message('No logs folder found', {
                                        title: 'Error',
                                        kind: 'warning',
                                        okLabel: 'OK',
                                    })
                                    return
                                }
                                await revealItem(logFile)
                            }}
                        >
                            Open Logs Folder
                        </Button>

                        <Button
                            fullWidth={true}
                            color="default"
                            onPress={async () => {
                                await writeText(jsonStringified)
                            }}
                        >
                            Copy Debug Info
                        </Button>
                        <Button
                            fullWidth={true}
                            color="danger"
                            onPress={async () => {
                                if (!info.dirs?.appLog) {
                                    await message('No logs folder found', {
                                        title: 'Error',
                                        kind: 'warning',
                                        okLabel: 'OK',
                                    })
                                    return
                                }

                                const body = `ENTER YOUR DESCRIPTION OF THE ISSUE HERE

							
Debug Info:
\`\`\`json
${jsonStringified}
\`\`\`

Logs (last 30 lines):
\`\`\`
${logsQuery.data?.join('\n')}
\`\`\`
`
                                openUrl(
                                    `https://github.com/rclone-ui/rclone-ui/issues/new?body=${encodeURIComponent(
                                        body
                                    )}`
                                )
                            }}
                        >
                            Open Github Issue
                        </Button>
                    </div>

                    <Textarea
                        value={jsonStringified}
                        size="lg"
                        label="Debug"
                        minRows={40}
                        maxRows={50}
                        disableAutosize={false}
                        isReadOnly={false}
                        variant="faded"
                        className="pb-10"
                        autoCapitalize="false"
                        autoComplete="false"
                        autoCorrect="false"
                        spellCheck="false"
                    />
                </div>
            )}
        </BaseSection>
    )
}
