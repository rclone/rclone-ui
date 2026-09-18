import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import SettingsGate from './SettingsGate'
import { SETTINGS_SECTIONS, type SectionKey, isSectionKey } from './sections'

// The browser shell shows one settings section per route (`/settings/:section?`, `/remotes`) and
// leaves the section list to its sidebar; the desktop keeps the tabbed window (`index.tsx`).
// The desktop-era `?tab=` links land here too and are redirected to the section's route.
export default function SectionPage({ section: fixed }: { section?: SectionKey }) {
    const params = useParams<{ section?: string }>()
    const [searchParams] = useSearchParams()

    const tab = searchParams.get('tab')
    if (tab) {
        const rest = new URLSearchParams(searchParams)
        rest.delete('tab')
        const query = rest.toString()
        const path =
            tab === 'remotes' ? '/remotes' : tab === 'general' ? '/settings' : `/settings/${tab}`
        return <Navigate to={query ? `${path}?${query}` : path} replace={true} />
    }

    const key: SectionKey = fixed ?? (isSectionKey(params.section) ? params.section : 'general')
    const Section = SETTINGS_SECTIONS[key].component

    return (
        <SettingsGate>
            <Section />
        </SettingsGate>
    )
}
