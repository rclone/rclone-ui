import { Events } from '@wailsio/runtime'
import { useEffect, useState } from 'react'
import { useAppInfo } from '../../lib/app'
import { invalidates } from '../../lib/live'
import { type CoreStatus, core } from '../../lib/shell'

/** A diagnostics page: the core's status, the app info, and the events that windows receive. */
function Test() {
    const [status, setStatus] = useState<CoreStatus | null>(null)
    const [events, setEvents] = useState<{ name: string; data: unknown }[]>([])
    const infoQuery = useAppInfo()

    useEffect(() => core.onState(setStatus), [])
    useEffect(() => {
        const names = [...Object.keys(invalidates), 'core.resync', 'config.changed']
        const offs = names.map((name) =>
            Events.On(name, (e) =>
                setEvents((prev) => [{ name: e.name, data: e.data }, ...prev].slice(0, 50))
            )
        )
        return () => {
            for (const off of offs) off()
        }
    }, [])

    return (
        <main className="flex flex-col gap-4 p-6 font-mono text-small">
            <section>
                <h2 className="font-bold">Core</h2>
                <pre>{JSON.stringify(status, null, 2)}</pre>
            </section>
            <section>
                <h2 className="font-bold">app.Info</h2>
                <pre>
                    {infoQuery.error
                        ? String(infoQuery.error)
                        : JSON.stringify(infoQuery.data, null, 2)}
                </pre>
            </section>
            <section>
                <h2 className="font-bold">Events</h2>
                <ul>
                    {events.map((e, i) => (
                        <li key={`${e.name}-${i}`}>
                            {e.name} {JSON.stringify(e.data)}
                        </li>
                    ))}
                </ul>
            </section>
        </main>
    )
}

export default Test
