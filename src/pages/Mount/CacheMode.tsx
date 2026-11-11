import { cn, Radio, RadioGroup } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { useId } from 'react'
import { SURFACE } from '../../components/look/Panel'
import { SectionTitle } from '../../components/look/SectionTitle'
import { type BoundGroup, useBoundOption } from '../../components/operation/optionBinding'

// The cache modes offered for a mount, stored in the VFS group's vfs_cache_mode. rclone also has
// a "minimal" mode, which isn't offered here, so no option is selected for it.
const MODES = [
    {
        value: 'off',
        label: t({ message: 'Off', comment: 'A cache mode of a mount: no cache.' }),
        help: t`Most apps can open files, but not save them.`,
    },
    {
        value: 'writes',
        label: t({
            message: 'Writes',
            comment: 'A cache mode of a mount: only writes are cached.',
        }),
        help: t`Apps can edit files locally, and the changes are uploaded in the background.`,
    },
    {
        value: 'full',
        label: t({ message: 'Full', comment: 'A cache mode of a mount: everything is cached.' }),
        help: t`Also keeps the files you open on this computer, for fast access.`,
    },
] as const

// The mount's violet (look/tones.ts), for the ring of the picked card.
const PICKED =
    'data-[selected=true]:shadow-[0_0_0_2px_rgb(139_92_246),0_6px_16px_-6px_rgb(139_92_246/0.45)] dark:data-[selected=true]:shadow-[0_0_0_2px_rgb(139_92_246),0_6px_16px_-6px_rgb(139_92_246/0.6)]'

/**
 * Three cards that pick the mount's cache mode. The mode is written to the VFS group's JSON. When
 * no mode is set, `fallback` (the app-wide value) is shown, or else rclone's default, off.
 */
export default function CacheMode({ group, fallback }: { group: BoundGroup; fallback?: string }) {
    const { value, set, disabled } = useBoundOption(group, 'vfs_cache_mode')
    const titleId = useId()
    return (
        <section className="flex flex-col gap-3">
            <SectionTitle id={titleId} className="px-1" title={t`Cache`} />
            <RadioGroup
                aria-labelledby={titleId}
                orientation="horizontal"
                size="sm"
                value={typeof value === 'string' ? value : (fallback ?? 'off')}
                isDisabled={disabled}
                onValueChange={(mode) => set(mode)}
                classNames={{ wrapper: 'grid grid-cols-3 gap-3' }}
            >
                {MODES.map((mode) => (
                    <Radio
                        key={mode.value}
                        value={mode.value}
                        description={mode.help}
                        classNames={{
                            base: cn(
                                SURFACE,
                                'm-0 max-w-none w-full items-start gap-2.5 p-3.5 transition-shadow duration-150',
                                PICKED
                            ),
                            wrapper:
                                'mt-0.5 group-data-[selected=true]:border-violet-500 dark:group-data-[selected=true]:border-violet-400',
                            control: 'bg-violet-500 dark:bg-violet-400',
                            labelWrapper: 'ms-0 gap-0.5',
                            label: 'font-medium text-small',
                            description: 'text-tiny leading-snug text-default-500 text-pretty',
                        }}
                    >
                        {mode.label}
                    </Radio>
                ))}
            </RadioGroup>
        </section>
    )
}
