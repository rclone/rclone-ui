import type { CopyVerifyOperation, TransferUnit } from '../../types/copyVerify'
import { type BatchInput, toConfigParam } from '../rclone/requests'

function repairConfig(options: CopyVerifyOperation['executionOptions']): string | undefined {
    return toConfigParam({
        ...(options.copy || {}),
        ...(options.config || {}),
        ignore_existing: false,
        immutable: false,
        ignore_times: true,
        dry_run: false,
    })
}

export function buildRepairInputs(operation: CopyVerifyOperation): {
    inputs: BatchInput[]
    units: TransferUnit[]
} {
    const issues = [...operation.missingFiles, ...operation.differentFiles]
    const configParam = repairConfig(operation.executionOptions)
    const inputs: BatchInput[] = []
    const units: TransferUnit[] = []

    for (const issue of issues) {
        const unit = operation.transferUnits.find((candidate) => candidate.id === issue.unitId)
        if (!unit) continue
        const copyInput = unit.copyInput
        if (unit.kind === 'folder') {
            inputs.push({
                _path: 'operations/copyfile',
                srcFs: copyInput.srcFs,
                srcRemote: issue.path,
                dstFs: copyInput.dstFs,
                dstRemote: issue.path,
                ...(configParam ? { _config: configParam } : {}),
            })
        } else {
            inputs.push({
                _path: 'operations/copyfile',
                srcFs: copyInput.srcFs,
                srcRemote: copyInput.srcRemote,
                dstFs: copyInput.dstFs,
                dstRemote: copyInput.dstRemote,
                ...(configParam ? { _config: configParam } : {}),
            })
        }
        units.push(unit)
    }

    return { inputs, units }
}
