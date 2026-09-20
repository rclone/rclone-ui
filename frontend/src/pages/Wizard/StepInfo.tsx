import { Button } from '@heroui/react'
import { ExternalLinkIcon } from 'lucide-react'
import { openUrl } from '@/navigate'
import type { Info } from './flow'

/**
 * The quiet panel under a step's options: what the step means and what the pick implies, with
 * the rclone docs for the operation where there is a page for it. Same surface as the option
 * cards, with a faint fill so it does not read as one more card to press.
 */
export default function StepInfo({ info }: { info: Info }) {
    const { paragraphs, link } = info
    return (
        <aside
            aria-label="About this step"
            className="flex flex-col gap-2 p-4 border rounded-xl border-divider bg-default-50 dark:border-neutral-800 dark:bg-white/[0.03]"
        >
            <span className="text-[11px] font-medium tracking-[0.14em] uppercase text-default-500">
                About this step
            </span>
            {paragraphs.map((text) => (
                <p key={text} className="text-sm leading-relaxed text-default-500">
                    {text}
                </p>
            ))}
            {link && (
                <Button
                    size="sm"
                    variant="flat"
                    className="mt-1 self-start"
                    endContent={<ExternalLinkIcon className="w-3.5 h-3.5" />}
                    onPress={() => openUrl(link.url)}
                >
                    {link.label}
                </Button>
            )}
        </aside>
    )
}
