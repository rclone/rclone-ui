import { Button, cn } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { ExclamationTriangle as ExclamationTriangleIcon } from '@zappicon/react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportPageError } from '../lib/telemetry'
import EmptyState from './components/EmptyState'
import { toneButton } from './components/look/buttons'
import { SURFACE } from './components/look/Panel'

/**
 * Catches a page that failed to render, so the window isn't left blank. It logs the error to the
 * console, which the app's log keeps.
 */
export default class ErrorBoundary extends Component<
    { children: ReactNode },
    { error: Error | null }
> {
    state = { error: null as Error | null }

    static getDerivedStateFromError(error: Error) {
        return { error }
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('[page] render failed', error, info.componentStack)
        reportPageError(error)
    }

    render() {
        if (!this.state.error) return this.props.children
        return (
            <EmptyState
                icon={ExclamationTriangleIcon}
                tone="red"
                title={t`This window stopped working`}
                description={t`Something went wrong while it was shown. Reloading it usually brings it back, and nothing you saved is lost.`}
                actions={
                    <Button
                        color="primary"
                        className={toneButton('blue')}
                        onPress={() => window.location.reload()}
                    >
                        <Trans>Reload</Trans>
                    </Button>
                }
                className="min-h-screen"
            >
                <details className="text-left group">
                    <summary className="text-center cursor-default select-none text-small text-default-500 hover:text-foreground">
                        <Trans>Details</Trans>
                    </summary>
                    <pre
                        className={cn(
                            SURFACE,
                            'mt-3 overflow-auto whitespace-pre-wrap rounded-xl p-4 font-mono text-[11px] leading-relaxed text-danger-600 dark:text-danger-500 max-h-64 [overflow-wrap:anywhere] select-text'
                        )}
                    >
                        {this.state.error.stack ?? String(this.state.error)}
                    </pre>
                </details>
            </EmptyState>
        )
    }
}
