import { cn } from '@heroui/react'
import { useState } from 'react'
import { platform } from '../../../lib/shell'
import { usePageQuery } from '../../route'
import HistoryList from './HistoryList'
import TransferDetails from './TransferDetails'
import TransferRetry from './TransferRetry'

type View = { kind: 'list' } | { kind: 'details'; id: string } | { kind: 'retry'; id: string }

/**
 * The History window. Another window's "Show transfer" opens it with `?id=`, which starts it on
 * that transfer's details.
 */
export default function History() {
    const query = usePageQuery()
    const [view, setView] = useState<View>(() => {
        const id = query.get('id')
        return id ? { kind: 'details', id } : { kind: 'list' }
    })
    const toList = () => setView({ kind: 'list' })
    const toDetails = (id: string) => setView({ kind: 'details', id })
    return (
        <div className={cn('relative flex flex-col h-screen', platform() === 'macos' && 'pt-7')}>
            {/* The list stays mounted under the other views, so Back finds it as it was. */}
            <div className={cn('flex flex-col flex-1 min-h-0', view.kind !== 'list' && 'hidden')}>
                <HistoryList
                    onSelect={toDetails}
                    onRetry={(id) => setView({ kind: 'retry', id })}
                />
            </div>
            {view.kind === 'details' && (
                <TransferDetails
                    key={view.id}
                    id={view.id}
                    onBack={toList}
                    onSelect={toDetails}
                    onRetry={() => setView({ kind: 'retry', id: view.id })}
                />
            )}
            {view.kind === 'retry' && (
                <TransferRetry
                    key={view.id}
                    id={view.id}
                    onBack={() => toDetails(view.id)}
                    onHistory={toList}
                    onStarted={toDetails}
                />
            )}
        </div>
    )
}
