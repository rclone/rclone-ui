import { describe, expect, it } from 'vitest'
import type { CopyVerifyOperation } from '../../types/copyVerify'
import { buildCopyReport } from './report'

const operation: CopyVerifyOperation = {
    id: 'operation-1',
    hostId: 'local',
    sources: ['/source/'],
    destination: '/destination/',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:01:00.000Z',
    completedAt: '2026-08-17T00:01:00.000Z',
    phase: 'complete',
    result: 'verification_failed',
    verificationMethod: { kind: 'checksum', hashTypes: ['md5'] },
    filesChecked: 3,
    missingFiles: [{ unitId: 'unit-1', path: 'missing[1].txt', message: 'not found' }],
    differentFiles: [],
    errors: [],
    copyDurationSeconds: 1,
    verificationDurationSeconds: 2,
    totalDurationSeconds: 3,
    verificationJobs: [],
    repairJobs: [],
    transferUnits: [],
    executionOptions: {
        copy: { secret_option: 'must not appear' },
        config: {},
        filter: {},
        remotes: {},
    },
}

describe('Copy + Verify report', () => {
    it('contains contextual failures but no successful filenames or remote options', () => {
        const report = buildCopyReport(operation)
        expect(report).toContain('missing\\[1\\]\\.txt')
        expect(report).toContain('Files checked: 3')
        expect(report).not.toContain('secret_option')
        expect(report).not.toContain('match.txt')
    })
})
