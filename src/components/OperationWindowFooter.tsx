/**
 * The action bar of an operation page. It stays at the bottom of the window while the page
 * scrolls under it. The page fades out behind it, so the text that scrolls by doesn't show around
 * it.
 */
export default function OperationWindowFooter({ children }: { children: React.ReactNode }) {
    return (
        <div className="sticky bottom-0 z-50 w-full max-w-3xl px-5 pt-6 pb-4 mx-auto pointer-events-none">
            <div
                aria-hidden={true}
                className="absolute inset-x-0 bottom-0 -z-10 top-0 bg-linear-to-t from-background from-40% to-transparent dark:from-[#121212]"
            />
            <div className="flex items-center gap-2 p-2 pointer-events-auto rounded-[22px] bg-white/[0.92] backdrop-blur-xl backdrop-saturate-150 shadow-[0_0_0_1px_rgb(0_0_0/0.07),0_10px_30px_-8px_rgb(0_0_0/0.22)] dark:bg-[#232326]/[0.92] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.09),0_10px_30px_-8px_rgb(0_0_0/0.9)]">
                {children}
            </div>
        </div>
    )
}
