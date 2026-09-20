import { useMutation } from '@tanstack/react-query'

import { onErrorDialog } from '@/lib/errors'
import { ask } from '@/dialog'
import { navigate } from '@/navigate'

/**
 * The dry-run mutation shared by the operation pages that offer one (Copy/Sync/Move/Delete).
 * The page supplies the whole mutationFn — including its path validation and the per-page
 * `config: { ...configOptions, dry_run: true }` merge, which must stay in the page so no page
 * can silently lose the dry_run injection.
 */
export function useOperationDryRun(mutationFn: () => Promise<unknown>) {
    return useMutation({
        mutationFn,
        onSuccess: async () => {
            const result = await ask(
                'Dry run started, you can check the results in the Transfers screen',
                {
                    title: 'Preview (Dry Run)',
                    kind: 'info',
                    okLabel: 'Open Transfers',
                    cancelLabel: 'OK',
                }
            )
            if (result) {
                navigate('/transfers')
            }
        },
        onError: onErrorDialog('Dry Run', 'Failed to start dry run', {
            log: ['Error starting dry run:'],
        }),
    })
}
