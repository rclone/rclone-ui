import { Card } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { useQuery } from '@tanstack/react-query'
import {
    Bug as BugIcon,
    Clipboard as ClipboardIcon,
    Folder as FolderIcon,
    MessagePlus as MessagePlusIcon,
} from '@zappicon/react'
import { type ComponentType, useMemo, useState } from 'react'
import { clipboard, message, openUrl, revealPath } from '../../../lib/shell'
import { IconTile } from '../../components/look/IconTile'
import type { Tone } from '../../components/look/tones'
import { toastSuccess } from '../../components/toast'
import { useAbout } from './AboutHeader'
import { FeatureRequestNotice } from './FeatureRequestNotice'
import { lastLogLines } from './logs'
import { SettingsGroup } from './SettingsGroup'
import { SECTIONS } from './sections'

export default function HelpGroup() {
    const { debug, logsFile } = useAbout()
    const logsQuery = useQuery({
        queryKey: ['about', 'logs'],
        queryFn: () => lastLogLines(30),
    })
    const jsonStringified = useMemo(() => (debug ? JSON.stringify(debug, null, 2) : ''), [debug])
    // "Request a feature" first shows what Rclone UI leaves out on purpose, then goes to GitHub.
    const [noticeOpen, setNoticeOpen] = useState(false)

    return (
        <SettingsGroup
            id="help"
            {...SECTIONS.help}
            className="grid grid-cols-1 gap-1 p-2 divide-y-0 min-[560px]:grid-cols-2"
        >
            <HelpTile
                icon={MessagePlusIcon}
                tone="orange"
                title={t`Request a feature`}
                description={t`Suggest an idea on GitHub.`}
                onPress={() => setNoticeOpen(true)}
            />
            <HelpTile
                icon={BugIcon}
                tone="red"
                title={t`Report a problem`}
                description={t`Opens a GitHub issue with your debug info and recent logs.`}
                isDisabled={!debug}
                onPress={() => {
                    // The report stays in English, because the maintainers read it.
                    const body = `ENTER YOUR DESCRIPTION OF THE ISSUE HERE


Debug Info:
\`\`\`json
${jsonStringified}
\`\`\`

Logs (last 30 lines):
\`\`\`
${logsQuery.data?.join('\n') ?? ''}
\`\`\`
`
                    openUrl(
                        `https://github.com/rclone/rclone-ui/issues/new?body=${encodeURIComponent(body)}`
                    )
                }}
            />
            <HelpTile
                icon={FolderIcon}
                tone="blue"
                title={t`Open the logs folder`}
                description={t`See what Rclone UI and rclone recorded as they ran.`}
                onPress={async () => {
                    if (!logsFile) {
                        await message(t`Rclone UI couldn't find its logs folder.`, {
                            title: t`Logs`,
                            kind: 'warning',
                        })
                        return
                    }
                    await revealPath(logsFile)
                }}
            />
            <HelpTile
                icon={ClipboardIcon}
                tone="graphite"
                title={t`Copy debug info`}
                description={t`Versions and folders, to paste into a report.`}
                isDisabled={!debug}
                onPress={async () => {
                    await clipboard.setText(jsonStringified)
                    toastSuccess(t`Debug info copied`)
                }}
            />
            <FeatureRequestNotice isOpen={noticeOpen} onOpenChange={setNoticeOpen} />
        </SettingsGroup>
    )
}

function HelpTile({
    icon,
    tone,
    title,
    description,
    isDisabled,
    onPress,
}: {
    icon: ComponentType<{ className?: string }>
    tone: Tone
    title: string
    description: string
    isDisabled?: boolean
    onPress: () => void
}) {
    return (
        <Card
            isPressable={true}
            isDisabled={isDisabled}
            onPress={onPress}
            shadow="none"
            radius="sm"
            className="flex flex-row items-start gap-3 p-3 rounded-xl text-start bg-transparent data-[hover=true]:bg-default-100 dark:data-[hover=true]:bg-default-50 transition-[background-color,scale] duration-150 data-[pressed=true]:scale-[0.98] motion-reduce:transition-none"
        >
            <IconTile icon={icon} tone={tone} size="md" />
            <span className="flex flex-col gap-0.5 min-w-0">
                <span className="font-medium text-small">{title}</span>
                <span className="text-xs leading-relaxed text-default-500 text-pretty">
                    {description}
                </span>
            </span>
        </Card>
    )
}
