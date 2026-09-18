/**
 * The action bar at the bottom of an operation window. In the desktop's windows (840 px by
 * default) it is an edge-to-edge bar; in a window or tab clearly wider than the content column
 * (960 px and up) it floats as a rounded island capped at the column's width, so its buttons
 * never stretch across the screen. The switch is a container query on the bar's own width
 * (src/global.css `.op-footer`), so the browser's sidebar doesn't count.
 */
export default function OperationWindowFooter({ children }: { children: React.ReactNode }) {
    return (
        <div className="sticky bottom-0 z-50 flex-none w-full op-footer">
            <div className="flex items-center justify-center gap-2 p-4 border-t border-divider dark:border-neutral-500/20 bg-content3/60 dark:bg-neutral-900/70 backdrop-blur-lg op-footer-bar">
                {children}
            </div>
        </div>
    )
}
