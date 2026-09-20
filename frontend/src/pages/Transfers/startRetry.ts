import type { OperationPreset } from '@/lib/rclone/preset'
import { submit } from '@/lib/rclone/start'
import { type RetryItem, retryRequest } from '@/lib/transfers/retry'
import type { TransferDetail, TransferEntry, TransferTag } from '@/server/transfers'

/**
 * Retries a selection of a transfer's failures as one new transfer (`lib/transfers/retry.ts`
 * says what can be retried and how). It keeps what the original was: its operation, its
 * destination, its settings and whether it was a dry run; its sources are what is retried.
 */
export async function startRetry(of: TransferEntry, items: RetryItem[], detail: TransferDetail) {
    return submit(
        retryRequest(items, detail),
        {
            operation: of.operation,
            sources: items.map((item) => item.source),
            destination: of.destination,
        },
        {
            isDryRun: of.isDryRun,
            preset: of.preset as OperationPreset | undefined,
            retryOf: of.id,
            // A retry comes from where what it retries came from.
            tags: of.tags as TransferTag[],
        }
    )
}

