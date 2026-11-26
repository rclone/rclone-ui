import { t } from '@lingui/core/macro'
import { useMutation } from '@tanstack/react-query'
import { onErrorDialog } from '../../../lib/errors'
import { ask, openWindow } from '../../../lib/shell'

export function useOperationDryRun(mutationFn: () => Promise<unknown>) {
    return useMutation({
        mutationFn,
        onSuccess: async () => {
            const result = await ask(t`The dry run has started. Check the result in History.`, {
                title: t`Preview (dry run)`,
                kind: 'info',
                okLabel: t`Open History`,
                cancelLabel: t`OK`,
            })
            if (result) {
                await openWindow('/history')
            }
        },
        onError: onErrorDialog(t`Dry run`, t`Failed to start dry run`, {
            log: ['Error starting dry run:'],
        }),
    })
}
