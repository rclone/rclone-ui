import { Button, Input, Spinner } from '@heroui/react'
import { EyeIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { message } from '../../../lib/api/dialog'
import { useLifecyclePhase } from '../../../lib/api/lifecycle'
import { usePersistedStore } from '../../../store/persisted'

// What stands between the user and any settings section: the daemon restarting, and the settings
// pin. Once per page load: the browser shell mounts a page per settings route and must not ask
// again at every section; a reload asks again, like a fresh native window does.
let unlocked = false

export default function SettingsGate({ children }: { children: ReactNode }) {
    const settingsPass = usePersistedStore((state) => state.settingsPass)
    const phase = useLifecyclePhase()
    const isRestartingRclone =
        phase !== null &&
        phase.phase !== 'ready' &&
        phase.phase !== 'stopped' &&
        phase.phase !== 'failed' &&
        phase.phase !== 'needsPassword'

    const [passwordCheckInput, setPasswordCheckInput] = useState('')
    const [passwordCheckPassed, setPasswordCheckPassed] = useState(unlocked)
    const [passwordVisible, setPasswordVisible] = useState(false)

    if (isRestartingRclone) {
        return (
            <div className="flex flex-col items-center justify-center w-screen h-screen gap-10 overflow-hidden animate-fade-in">
                <Spinner size="lg" className="scale-150" />
                <p className="text-lg text-center text-neutral-500">Restarting rclone...</p>
            </div>
        )
    }

    const checkPassword = async () => {
        if (passwordCheckInput === settingsPass) {
            unlocked = true
            setPasswordCheckPassed(true)
            return
        }
        await message('The password you entered is incorrect.', {
            title: 'Login failed',
            kind: 'error',
        })
    }

    if (settingsPass && !passwordCheckPassed) {
        return (
            <div className="flex flex-col items-center justify-center w-screen h-screen gap-4 overflow-hidden animate-fade-in">
                <Input
                    placeholder="Enter pin or password"
                    value={passwordCheckInput}
                    onChange={(e) => setPasswordCheckInput(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') checkPassword()
                    }}
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                    type={passwordVisible ? 'text' : 'password'}
                    fullWidth={false}
                    size="lg"
                    endContent={
                        <Button
                            onPress={() => setPasswordVisible(!passwordVisible)}
                            isIconOnly={true}
                            variant="light"
                            data-focus-visible="false"
                        >
                            <EyeIcon className="w-5 h-5" />
                        </Button>
                    }
                />
                <Button onPress={checkPassword} data-focus-visible="false" color="primary">
                    Open
                </Button>
            </div>
        )
    }

    return <>{children}</>
}
