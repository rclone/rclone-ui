import { lazy, Suspense, useEffect, useState } from 'react'
import { usePref, usePrefsLoaded } from '../../../lib/prefs'

const SEEN = 'commanderIntro'
const IntroDialog = lazy(() => import('./IntroDialog'))

export default function Intro() {
    const loaded = usePrefsLoaded()
    const [acknowledged, setAcknowledged] = usePref('acknowledgements')
    const [due, setDue] = useState<boolean | null>(null)
    useEffect(() => {
        if (loaded && due === null) setDue(!acknowledged.includes(SEEN))
    }, [loaded, due, acknowledged])

    if (!due) return null
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
