import { Input } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { type ReactNode, useState } from 'react'
import { Panel } from '../look/Panel'
import { SectionTitle } from '../look/SectionTitle'
import { type BoundGroup, itemsOf, useBoundOption } from './optionBinding'

export default function CommonSettings({
    title = t`Common settings`,
    children,
}: {
    title?: string
    children: ReactNode
}) {
    return (
        <section aria-label={title} className="flex flex-col gap-3">
            <SectionTitle className="px-1" title={title} />
            <Panel className="grid grid-cols-2 p-4 gap-x-4 gap-y-4">{children}</Panel>
        </section>
    )
}

export function SettingText({
    group,
    name,
    label,
    help,
    placeholder,
    list = false,
    type = 'text',
}: {
    group: BoundGroup
    name: string
    label: string
    help?: string
    placeholder?: string
    list?: boolean
    type?: 'text' | 'password'
}) {
    const { value, set, disabled } = useBoundOption(group, name)
    const [draft, setDraft] = useState<string>()
    const text = list
        ? itemsOf(value).join(', ')
        : typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : ''
    return (
        <Input
            size="sm"
            type={type}
            label={label}
            description={help}
            placeholder={placeholder}
            value={draft ?? text}
            isDisabled={disabled}
            onValueChange={(next) => {
                setDraft(next)
                if (list) {
                    const items = next
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean)
                    set(items.length > 0 ? items : undefined)
                } else {
                    set(next === '' ? undefined : next)
                }
            }}
            onBlur={() => setDraft(undefined)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
        />
    )
}
