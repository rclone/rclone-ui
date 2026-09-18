import { Button, Card, CardBody, CardHeader, Input } from '@heroui/react'
import {
    EyeIcon,
    EyeOffIcon,
    KeyRoundIcon,
    LogInIcon,
    TriangleAlertIcon,
    UserIcon,
} from 'lucide-react'
import { useState } from 'react'

// The browser's sign-in: a frosted card over a soft glow, with the app icon drifting corner to
// corner behind it the way a DVD player's logo does (rclone-web's login, adapted).
export default function Login() {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [pending, setPending] = useState(false)

    return (
        <div className="relative flex items-center justify-center w-full min-h-dvh px-4 overflow-hidden bg-content2 dark:bg-[#121212]">
            <div
                aria-hidden="true"
                className="absolute inset-0 pointer-events-none animate-login-dvd-x motion-reduce:animate-none"
            >
                <div className="w-14 animate-login-dvd-y motion-reduce:animate-none">
                    <img src="/icon.png" alt="" className="w-14 h-14 invert dark:invert-0" />
                </div>
            </div>

            <Card
                shadow="none"
                className="relative w-full max-w-sm animate-fade-in-up motion-reduce:animate-none bg-content1/80 backdrop-blur-xl ring-1 ring-foreground/10"
            >
                <CardHeader className="justify-center pt-6 pb-0">
                    <h1 className="text-lg font-semibold tracking-tight">Login</h1>
                </CardHeader>
                <CardBody className="p-6">
                    <form
                        className="flex flex-col gap-4"
                        onSubmit={async (e) => {
                            e.preventDefault()
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
                        {error && (
                            <div
                                role="alert"
                                className="flex items-start gap-2 px-3 py-2 text-sm border rounded-lg border-danger/30 bg-danger/10 text-danger"
                            >
                                <TriangleAlertIcon className="w-4 h-4 mt-0.5 shrink-0" />
                                <span>{error}</span>
                            </div>
                        )}
                        <Input
                            autoFocus={true}
                            type="email"
                            label="Email"
                            labelPlacement="outside"
                            placeholder="you@example.com"
                            autoComplete="username"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck="false"
                            startContent={<UserIcon className="w-4 h-4 text-default-400" />}
                            value={email}
                            onValueChange={(value) => {
                                setEmail(value)
                                setError(null)
                            }}
                            isDisabled={pending}
                        />
                        <Input
                            type={showPassword ? 'text' : 'password'}
                            label="Password"
                            labelPlacement="outside"
                            placeholder="••••••••"
                            autoComplete="current-password"
                            startContent={<KeyRoundIcon className="w-4 h-4 text-default-400" />}
                            endContent={
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    onClick={() => setShowPassword((value) => !value)}
                                    className="rounded-md outline-none text-default-400 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                                >
                                    {showPassword ? (
                                        <EyeOffIcon className="w-4 h-4" />
                                    ) : (
                                        <EyeIcon className="w-4 h-4" />
                                    )}
                                </button>
                            }
                            value={password}
                            onValueChange={(value) => {
                                setPassword(value)
                                // Native form validation would block the next submit while the
                                // field is still flagged invalid.
                                setError(null)
                            }}
                            isDisabled={pending}
                        />
                        <Button
                            color="primary"
                            type="submit"
                            isLoading={pending}
                            startContent={!pending && <LogInIcon className="w-4 h-4" />}
                            className="mt-1 font-medium"
                        >
                            Sign in
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </div>
    )
}
