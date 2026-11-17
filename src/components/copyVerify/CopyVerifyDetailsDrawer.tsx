import {
    Button,
    Drawer,
    DrawerBody,
    DrawerContent,
    DrawerFooter,
    DrawerHeader,
} from '@heroui/react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { message } from '@tauri-apps/plugin-dialog'
import { useState } from 'react'
import {
    repairCopyVerify,
    stopCopyVerify,
    verifyAgainCopyVerify,
} from '../../../lib/copyVerify/commands'
import { buildCopyReport, verificationMethodLabel } from '../../../lib/copyVerify/report'
import type { CopyVerifyOperation } from '../../../types/copyVerify'
import { copyVerifyLabel } from './CopyVerifyCard'

export default function CopyVerifyDetailsDrawer({
    operation,
    isOpen,
    onClose,
}: {
    operation: CopyVerifyOperation
    isOpen: boolean
    onClose: () => void
}) {
    const [isBusy, setIsBusy] = useState(false)
    const isActive = !['complete', 'verification_required'].includes(operation.phase)
    const canRepair =
        operation.result === 'verification_failed' &&
        (operation.missingFiles.length > 0 || operation.differentFiles.length > 0)
    const canVerifyAgain = operation.result !== 'copy_failed' && operation.result !== 'cancelled'

    const run = async (action: () => Promise<void>, success: string) => {
        setIsBusy(true)
        try {
            await action()
            await message(success, { title: 'Copy + Verify', kind: 'info' })
        } catch (error) {
            await message(error instanceof Error ? error.message : String(error), {
                title: 'Copy + Verify',
                kind: 'error',
            })
        } finally {
            setIsBusy(false)
        }
    }

    const handleCopyReport = () => {
        writeText(buildCopyReport(operation)).catch((error) =>
            console.error('[CopyVerify] report copy failed', error)
        )
    }

    const handleRepair = () => {
        run(() => repairCopyVerify(operation.id), 'Repair submitted.').catch((error) =>
            console.error('[CopyVerify] repair action failed', error)
        )
    }

    const handleVerifyAgain = () => {
        run(() => verifyAgainCopyVerify(operation.id), 'Verification submitted.').catch((error) =>
            console.error('[CopyVerify] verify-again action failed', error)
        )
    }

    const handleStop = () => {
        run(() => stopCopyVerify(operation.id), 'Operation stopped.').catch((error) =>
            console.error('[CopyVerify] stop action failed', error)
        )
    }

    return (
        <Drawer isOpen={isOpen} onClose={onClose} size="lg">
            <DrawerContent>
                <DrawerHeader className="flex flex-col gap-1">
                    <span>Copy + Verify</span>
                    <span className="text-small text-foreground-500">
                        {copyVerifyLabel(operation)}
                    </span>
                </DrawerHeader>
                <DrawerBody>
                    <p>
                        <strong>Operation ID:</strong> {operation.id}
                    </p>
                    <p>
                        <strong>Sources:</strong> {operation.sources.join(', ')}
                    </p>
                    <p>
                        <strong>Destination:</strong> {operation.destination}
                    </p>
                    <p>
                        <strong>Files checked:</strong>{' '}
                        {operation.filesChecked === null ? 'Unavailable' : operation.filesChecked}
                    </p>
                    <p>
                        <strong>Method:</strong> {verificationMethodLabel(operation)}
                    </p>
                    {(operation.missingFiles.length > 0 ||
                        operation.differentFiles.length > 0 ||
                        operation.errors.length > 0) && (
                        <div className="space-y-3">
                            {operation.missingFiles.length > 0 ? (
                                <IssueList
                                    title="Missing files"
                                    items={operation.missingFiles.map((item) => item.path)}
                                />
                            ) : null}
                            {operation.differentFiles.length > 0 ? (
                                <IssueList
                                    title="Different files"
                                    items={operation.differentFiles.map((item) => item.path)}
                                />
                            ) : null}
                            {operation.errors.length > 0 ? (
                                <IssueList
                                    title="Errors"
                                    items={operation.errors.map(
                                        (item) => `${item.path}: ${item.message ?? 'unknown error'}`
                                    )}
                                />
                            ) : null}
                        </div>
                    )}
                </DrawerBody>
                <DrawerFooter className="flex-wrap">
                    <Button onPress={handleCopyReport} variant="flat">
                        Copy Report
                    </Button>
                    {canRepair ? (
                        <Button color="warning" isLoading={isBusy} onPress={handleRepair}>
                            Repair Files and Recheck
                        </Button>
                    ) : null}
                    {canVerifyAgain ? (
                        <Button color="primary" isLoading={isBusy} onPress={handleVerifyAgain}>
                            Verify Again
                        </Button>
                    ) : null}
                    {isActive ? (
                        <Button
                            color="danger"
                            variant="flat"
                            isLoading={isBusy}
                            onPress={handleStop}
                        >
                            Stop
                        </Button>
                    ) : null}
                </DrawerFooter>
            </DrawerContent>
        </Drawer>
    )
}

function IssueList({ title, items }: { title: string; items: string[] }) {
    return (
        <div>
            <h3 className="font-semibold">{title}</h3>
            <ul className="pl-5 list-disc">
                {items.map((item, index) => (
                    <li key={`${item}-${index}`} className="break-all">
                        {item}
                    </li>
                ))}
            </ul>
        </div>
    )
}
