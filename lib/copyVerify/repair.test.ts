import { describe, expect, it } from 'vitest'
import type { CopyVerifyOperation, TransferUnit } from '../../types/copyVerify'
import { buildRepairInputs } from './repair'

const fileUnit: TransferUnit = {
    id: 'unit-1',
    kind: 'file',
    sourceDisplayPath: '/source/report.txt',
    destinationDisplayPath: '/destination/report.txt',
    copyInput: {
        _path: 'operations/copyfile',
        srcFs: ':local:/source',
        srcRemote: 'report.txt',
        dstFs: ':local:/destination',
        dstRemote: 'report.txt',
    },
    verificationInput: {
        _path: 'operations/check',
        srcFs: ':local:/source',
        dstFs: ':local:/destination',
    },
}

const operation: CopyVerifyOperation = {
    id: 'operation-1',
    hostId: 'local',
    sources: ['/source/report.txt'],
    destination: '/destination/',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    phase: 'complete',
    result: 'verification_failed',
    filesChecked: 1,
    missingFiles: [{ unitId: 'unit-1', path: 'missing.txt' }],
    differentFiles: [{ unitId: 'unit-1', path: 'report.txt' }],
    errors: [{ unitId: 'unit-1', path: 'permission denied' }],
    verificationJobs: [],
    repairJobs: [],
    transferUnits: [fileUnit],
    executionOptions: {
        copy: { ignore_existing: true, immutable: true },
        config: { dry_run: true },
        filter: {},
        remotes: {},
    },
}

describe('buildRepairInputs', () => {
    it('repairs only missing and different paths with overwrite-safe options', () => {
        const repair = buildRepairInputs(operation)

        expect(repair.units).toEqual([fileUnit, fileUnit])
        expect(repair.inputs).toHaveLength(2)
        expect(repair.inputs.map((input) => input.dstRemote)).toEqual(['report.txt', 'report.txt'])
        for (const input of repair.inputs) {
            expect(input._config).toContain('"IgnoreExisting":false')
            expect(input._config).toContain('"Immutable":false')
            expect(input._config).toContain('"IgnoreTimes":true')
            expect(input._config).toContain('"DryRun":false')
        }
    })

    it('does not create repair inputs from error-only issues', () => {
        const repair = buildRepairInputs({
            ...operation,
            missingFiles: [],
            differentFiles: [],
        })

        expect(repair.inputs).toEqual([])
        expect(repair.units).toEqual([])
    })
})
