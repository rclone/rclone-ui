import { Spinner } from '@heroui/react'
import type { ReactNode } from 'react'
import { useLifecyclePhase } from '@/server/lifecycle'

// What stands between the user and any settings section: the daemon restarting.
export default function SettingsGate({ children }: { children: ReactNode }) {
    const phase = useLifecyclePhase()
    const isRestartingRclone =
        phase !== null &&
        phase.phase !== 'ready' &&
        phase.phase !== 'stopped' &&
        phase.phase !== 'failed'

    if (isRestartingRclone) {
        return (
            <div className="flex flex-col items-center justify-center w-full h-full gap-10 overflow-hidden animate-fade-in">
                <Spinner size="lg" className="scale-150" />
                <p className="text-lg text-center">Restarting rclone...</p>
            </div>
        )
    }

    return <>{children}</>
}
