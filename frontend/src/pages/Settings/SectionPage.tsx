import { useParams } from 'react-router-dom'
import SettingsGate from './SettingsGate'
import { SETTINGS_SECTIONS, type SectionKey, isSectionKey } from './sections'

// One settings section per route (`/settings/:section?`, `/remotes`); the sidebar lists them.
export default function SectionPage({ section: fixed }: { section?: SectionKey }) {
    const params = useParams<{ section?: string }>()

    const key: SectionKey = fixed ?? (isSectionKey(params.section) ? params.section : 'rclone')
    const Section = SETTINGS_SECTIONS[key].component

    return (
        <SettingsGate>
            <Section />
        </SettingsGate>
    )
}
