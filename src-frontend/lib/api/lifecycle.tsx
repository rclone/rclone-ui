// The orchestrator's phase as React state: seeded from `/api/status`, then live from the
// `lifecycle.phase` bus event. `null` until the first status arrives (or when the daemon is
// external and there is no lifecycle at all).

import { useEffect, useState } from 'react'
import { status } from './app'
import { type LifecyclePhase, on } from './events'

let current: LifecyclePhase | null = null
let seeded: Promise<void> | null = null
const listeners = new Set<(phase: LifecyclePhase | null) => void>()

function publish(phase: LifecyclePhase | null) {
    current = phase
    for (const listener of listeners) listener(phase)
}

on('lifecycle.phase', (phase) => publish(phase))

function seed(): Promise<void> {
    if (!seeded) {
        seeded = status()
            .then((s) => {
                if (current === null) publish(s.lifecycle)
            })
            .catch(() => {})
    }
    return seeded
}

export function currentPhase(): LifecyclePhase | null {
    return current
}

export function useLifecyclePhase(): LifecyclePhase | null {
    const [phase, setPhase] = useState<LifecyclePhase | null>(current)
    useEffect(() => {
        listeners.add(setPhase)
        seed().then(() => setPhase(current))
        return () => {
            listeners.delete(setPhase)
        }
    }, [])
    return phase
}

/** Resolves once the daemon is ready (or immediately when there is no managed daemon). */
export async function whenReady(): Promise<void> {
    await seed()
    if (current === null || current.phase === 'ready') return
    await new Promise<void>((resolve) => {
        const listener = (phase: LifecyclePhase | null) => {
            if (phase === null || phase.phase === 'ready') {
                listeners.delete(listener)
                resolve()
            }
        }
        listeners.add(listener)
    })
}
