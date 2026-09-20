import { Button, Card, CardBody, CardHeader } from '@heroui/react'
import { TriangleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface Props {
    title: string
    error: string | null
    pending: boolean
    submit: { label: string; icon: ReactNode }
    onSubmit: () => void | Promise<void>
    children: ReactNode
}

// The screens before the app (sign-in, the first launch): a frosted card over a soft glow, with
// the app icon drifting corner to corner behind it the way a DVD player's logo does (rclone-web's
// login, adapted).
export function AuthCard({ title, error, pending, submit, onSubmit, children }: Props) {
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
                    <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
                </CardHeader>
                <CardBody className="p-6">
                    <form
                        className="flex flex-col gap-4"
                        onSubmit={(e) => {
                            e.preventDefault()
                            void onSubmit()
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
                        {children}
                        <Button
                            color="primary"
                            type="submit"
                            isLoading={pending}
                            startContent={!pending && submit.icon}
                            className="mt-1 font-medium"
                        >
                            {submit.label}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </div>
    )
}
