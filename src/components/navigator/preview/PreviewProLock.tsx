import { Button } from '@heroui/react'

/**
 * Paywall teaser shown over the preview for users without a valid license. The preview
 * renders underneath, blurred and darkened by a full-height transparent-to-black
 * gradient (smooth over heavy coverage) with the upsell copy and Unlock CTA at the
 * bottom. It captures pointer events, so the locked preview can be glimpsed but not
 * interacted with.
 */
export default function PreviewProLock({ onUnlock }: { onUnlock: () => void }) {
    return (
        <div className="absolute inset-0 z-20 flex flex-col justify-end bg-gradient-to-b from-transparent to-black backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3 px-6 pt-10 pb-9 text-center">
                <p className="text-2xl font-semibold tracking-tight text-white text-balance">
                    Unlock File Previews
                </p>

                <p className="max-w-xs text-sm leading-relaxed text-white/60 text-balance">
                    Plus Schedules, Notifications and everything else in Rclone UI Pro.
                </p>

                <Button
                    size="lg"
                    radius="full"
                    onPress={onUnlock}
                    className="mt-3 bg-white px-10 font-semibold text-black shadow-lg shadow-black/40 transition-colors hover:bg-white/90"
                    data-focus-visible="false"
                >
                    Unlock Pro
                </Button>
            </div>
        </div>
    )
}
