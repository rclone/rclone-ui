import { lazy, Suspense, useEffect, useState } from 'react'
import { usePref, usePrefsLoaded } from '../../../lib/prefs'

/** The acknowledgement recorded once the user has seen Commander's intro. */
const SEEN = 'commanderIntro'
const IntroDialog = lazy(() => import('./IntroDialog'))

/**
 * Shows Commander's intro the first time Commander opens on this machine. It is decided once, as
 * the preferences load, so the dialog stays closed even if saving the acknowledgement fails.
 */
export default function Intro() {
    const loaded = usePrefsLoaded()
    const [acknowledged, setAcknowledged] = usePref('acknowledgements')
    const [due, setDue] = useState<boolean | null>(null)
    useEffect(() => {
        if (loaded && due === null) setDue(!acknowledged.includes(SEEN))
    }, [loaded, due, acknowledged])

    if (!due) return null
    // The dialog closes itself, with its animation, so this only records that it was seen.
    const close = () => {
        if (acknowledged.includes(SEEN)) return
        setAcknowledged([...acknowledged, SEEN]).catch((error: unknown) =>
            console.warn('could not save the Commander intro as seen', error)
        )
    }
    return (
        <Suspense fallback={null}>
            <IntroDialog onClose={close} />
        </Suspense>
    )
}
