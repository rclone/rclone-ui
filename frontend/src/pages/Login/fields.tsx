import { Input } from '@heroui/react'
import { EyeIcon, EyeOffIcon, KeyRoundIcon, UserIcon } from 'lucide-react'
import { useState } from 'react'

interface FieldProps {
    value: string
    onValueChange: (value: string) => void
    isDisabled: boolean
}

export function EmailInput({ value, onValueChange, isDisabled }: FieldProps) {
    return (
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
            value={value}
            onValueChange={onValueChange}
            isDisabled={isDisabled}
        />
    )
}

interface PasswordProps extends FieldProps {
    label: string
    autoComplete: 'current-password' | 'new-password'
}

// A password field with its own show/hide toggle.
export function PasswordInput({
    label,
    autoComplete,
    value,
    onValueChange,
    isDisabled,
}: PasswordProps) {
    const [shown, setShown] = useState(false)
    return (
        <Input
            type={shown ? 'text' : 'password'}
            label={label}
            labelPlacement="outside"
            placeholder="••••••••"
            autoComplete={autoComplete}
            startContent={<KeyRoundIcon className="w-4 h-4 text-default-400" />}
            endContent={
                <button
                    type="button"
                    tabIndex={-1}
                    aria-label={shown ? 'Hide password' : 'Show password'}
                    onClick={() => setShown((value) => !value)}
                    className="rounded-md outline-none text-default-400 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                >
                    {shown ? <EyeOffIcon className="w-4 h-4" /> : <EyeIcon className="w-4 h-4" />}
                </button>
            }
            value={value}
            onValueChange={onValueChange}
            isDisabled={isDisabled}
        />
    )
}
