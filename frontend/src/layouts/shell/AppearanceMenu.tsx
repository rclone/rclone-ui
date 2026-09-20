import { Popover, PopoverContent, PopoverTrigger, Select, SelectItem } from '@heroui/react'
import { SettingsIcon } from 'lucide-react'
import { message } from '../../../lib/api/dialog'
import { type Theme, useTheme } from '../../../lib/theme'

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

// The header's cog: the two settings that belong to the tab itself rather than to the server.
export default function AppearanceMenu({ className }: { className?: string }) {
    const [theme, setTheme] = useTheme()

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
                    selectedKeys={[theme]}
                    disallowEmptySelection={true}
                    onSelectionChange={(keys) => setTheme(Array.from(keys)[0] as Theme)}
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
                            `${picked?.label ?? 'That language'} is not available yet. Rclone Cloud stays in English until the translations are ready.`,
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
