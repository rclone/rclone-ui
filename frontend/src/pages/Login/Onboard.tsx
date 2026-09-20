import { UserPlusIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSession } from '@/server/session'
import { AuthCard } from './AuthCard'
import { EmailInput, PasswordInput } from './fields'

// The first launch: no account exists yet, so the first visitor creates the owner's and is signed
// in as it. The server does this once; a tab that comes late is sent into the app instead.
export default function Onboard() {
    const navigate = useNavigate()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [confirm, setConfirm] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [pending, setPending] = useState(false)

    useEffect(() => {
        let cancelled = false
        getSession()
            .then((session) => {
                if (cancelled || session.onboard) return
                navigate(session.authenticated ? '/' : '/login', { replace: true })
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [navigate])

    const typed = (set: (value: string) => void) => (value: string) => {
        set(value)
        setError(null)
    }

    return (
        <AuthCard
            title="Create the owner account"
            error={error}
            pending={pending}
            submit={{ label: 'Create account', icon: <UserPlusIcon className="w-4 h-4" /> }}
            onSubmit={async () => {
                if (password !== confirm) {
                    setError('The passwords do not match')
                    return
                }
                setPending(true)
                setError(null)
                try {
                    const response = await fetch('/api/onboard', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ email, password }),
                    })
                    if (response.ok || response.status === 409) {
                        // Created and signed in, or created by another tab meanwhile: either way
                        // the app decides what comes next. A full reload, as after a sign-in.
                        window.location.assign('/')
                        return
                    }
                    const body = (await response.json().catch(() => null)) as {
                        error?: string
                    } | null
                    setError(body?.error ?? `The account could not be created (${response.status})`)
                } catch (err) {
                    setError(err instanceof Error ? err.message : String(err))
                } finally {
                    setPending(false)
                }
            }}
        >
            <EmailInput value={email} onValueChange={typed(setEmail)} isDisabled={pending} />
            <PasswordInput
                label="Password"
                autoComplete="new-password"
                value={password}
                onValueChange={typed(setPassword)}
                isDisabled={pending}
            />
            <PasswordInput
                label="Confirm password"
                autoComplete="new-password"
                value={confirm}
                onValueChange={typed(setConfirm)}
                isDisabled={pending}
            />
        </AuthCard>
    )
}
