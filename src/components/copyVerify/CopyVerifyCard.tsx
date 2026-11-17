import { Card, CardBody, Chip, Progress } from '@heroui/react'
import { ChevronRightIcon } from 'lucide-react'
import { buildReadablePathMultiple } from '../../../lib/format'
import type { CopyVerifyOperation } from '../../../types/copyVerify'

export function copyVerifyLabel(operation: CopyVerifyOperation): string {
    if (operation.result === 'verified') return 'VERIFIED'
    if (operation.result === 'verified_with_limitations') return 'VERIFIED WITH LIMITATIONS'
    if (operation.result === 'verification_failed') return 'VERIFICATION FAILED'
    if (operation.result === 'copy_failed') return 'COPY FAILED'
    if (operation.result === 'cancelled') return 'CANCELLED'
    if (operation.phase === 'verification_required') return 'VERIFICATION REQUIRED'
    if (operation.phase === 'repairing') return 'REPAIRING'
    if (operation.phase === 'verifying' || operation.phase === 'submitting_verification')
        return 'VERIFYING'
    return 'COPYING'
}

export default function CopyVerifyCard({
    operation,
    onSelect,
}: {
    operation: CopyVerifyOperation
    onSelect: (operation: CopyVerifyOperation) => void
}) {
    const label = copyVerifyLabel(operation)
    const isActive = !['complete', 'verification_required'].includes(operation.phase)
    const progress =
        operation.phase === 'verifying' || operation.phase === 'submitting_verification' ? 75 : 35

    return (
        <Card
            radius="none"
            shadow="none"
            className="w-full border-b border-divider"
            isPressable={true}
            onPress={() => onSelect(operation)}
            data-focus-visible="false"
        >
            <CardBody className="p-3">
                <div className="flex items-center gap-3">
                    <Chip
                        color={
                            isActive
                                ? 'warning'
                                : operation.result === 'verified'
                                  ? 'success'
                                  : 'danger'
                        }
                    >
                        COPY + VERIFY
                    </Chip>
                    <div className="flex-1 min-w-0 text-left">
                        <p className="font-bold truncate">
                            {buildReadablePathMultiple(operation.sources, 'short', true)} →{' '}
                            {operation.destination}
                        </p>
                        <p className="text-small text-foreground-500">{label}</p>
                        {isActive ? (
                            <Progress aria-label={label} value={progress} size="sm" />
                        ) : null}
                    </div>
                    <ChevronRightIcon className="w-5 shrink-0" />
                </div>
            </CardBody>
        </Card>
    )
}
