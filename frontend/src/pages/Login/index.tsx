import { LogInIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSession } from '@/server/session'
import { AuthCard } from './AuthCard'
import { EmailInput, PasswordInput } from './fields'

// The browser's sign-in.
export default function Login() {
    const navigate = useNavigate()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [pending, setPending] = useState(false)

    // Nobody to sign in as yet: the first launch creates the owner instead.
    useEffect(() => {
        let cancelled = false
        getSession()
            .then((session) => {
                if (!cancelled && session.onboard) navigate('/onboard', { replace: true })
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [navigate])

    return (
        <AuthCard
            title="Login"
            error={error}
            pending={pending}
            submit={{ label: 'Sign in', icon: <LogInIcon className="w-4 h-4" /> }}
            onSubmit={async () => {
                setPending(true)
                setError(null)
                try {
                    const response = await fetch('/api/login', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ email, password }),
                    })
                    if (!response.ok) {
                        setError('Wrong email or password')
                        return
                    }
                    // Full reload: the stores tried to hydrate before the cookie existed.
                    window.location.assign('/')
                } catch (err) {
                    setError(err instanceof Error ? err.message : String(err))
                } finally {
                    setPending(false)
                }
            }}
        >
            <EmailInput
                value={email}
                onValueChange={(value) => {
                    setEmail(value)
                    setError(null)
                }}
                isDisabled={pending}
            />
            <PasswordInput
                label="Password"
                autoComplete="current-password"
                value={password}
                onValueChange={(value) => {
                    setPassword(value)
                    // Native form validation would block the next submit while the field is
                    // still flagged invalid.
                    setError(null)
                }}
                isDisabled={pending}
            />
        </AuthCard>
    )
}
