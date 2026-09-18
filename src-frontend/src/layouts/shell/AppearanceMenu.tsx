import { Popover, PopoverContent, PopoverTrigger, Select, SelectItem } from '@heroui/react'
import { SettingsIcon } from 'lucide-react'
import { message } from '../../../lib/api/dialog'
import { usePersistedStore } from '../../../store/persisted'

// English is the only language until the translations land; the list shows what is coming.
const LANGUAGES = [
    { key: 'en', label: 'English' },
    { key: 'de', label: 'Deutsch' },
    { key: 'es', label: 'Español' },
    { key: 'fr', label: 'Français' },
    { key: 'it', label: 'Italiano' },
    { key: 'pt', label: 'Português' },
    { key: 'ja', label: '日本語' },
    { key: 'zh', label: '中文' },
]

// The header's cog: the two settings that belong to the tab itself rather than to the host it
// drives. The desktop has no such button; its windows follow the OS and Settings › General.
export default function AppearanceMenu({ className }: { className?: string }) {
    const appearance = usePersistedStore((state) => state.appearance)

    return (
        <Popover placement="bottom-end" offset={8}>
            <PopoverTrigger>
                <button type="button" aria-label="Settings" title="Settings" className={className}>
                    <SettingsIcon className="w-4 h-4" strokeWidth={1.75} />
                </button>
            </PopoverTrigger>
            <PopoverContent aria-label="Settings" className="items-stretch w-64 gap-3 p-3">
                <Select
                    label="App Theme"
                    selectedKeys={[appearance.app]}
                    disallowEmptySelection={true}
                    onSelectionChange={(keys) => {
                        const value = Array.from(keys)[0] as 'light' | 'dark' | 'system'
                        usePersistedStore.setState((state) => ({
                            appearance: { ...state.appearance, app: value },
                        }))
                    }}
                    size="sm"
                    data-focus-visible="false"
                >
                    <SelectItem key="system">System</SelectItem>
                    <SelectItem key="light">Light</SelectItem>
                    <SelectItem key="dark">Dark</SelectItem>
                </Select>

                <Select
                    label="Language"
                    selectedKeys={['en']}
                    disallowEmptySelection={true}
                    onSelectionChange={(keys) => {
                        const key = Array.from(keys)[0]
                        if (!key || key === 'en') return
                        const picked = LANGUAGES.find((language) => language.key === key)
                        message(
                            `${picked?.label ?? 'That language'} is not available yet. Rclone UI stays in English until the translations are ready.`,
                            { title: 'Coming soon', kind: 'info' }
                        )
                    }}
                    size="sm"
                    data-focus-visible="false"
                >
                    {LANGUAGES.map((language) => (
                        <SelectItem key={language.key}>{language.label}</SelectItem>
                    ))}
                </Select>
            </PopoverContent>
        </Popover>
    )
}
