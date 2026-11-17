import { describe, expect, it } from 'vitest'
import type { CopyVerifyOperation } from '../../types/copyVerify'
import { COPY_VERIFY_RETENTION_MS, pruneTerminalOperations } from './history'

function operation(
    id: string,
    phase: CopyVerifyOperation['phase'],
    completedAt: string
): CopyVerifyOperation {
    return {
        id,
        hostId: 'local',
        sources: ['/source/'],
        destination: '/destination/',
        createdAt: completedAt,
        updatedAt: completedAt,
        completedAt,
        phase,
        result: phase === 'complete' ? 'verified' : null,
        filesChecked: null,
        missingFiles: [],
        differentFiles: [],
        errors: [],
        verificationJobs: [],
        repairJobs: [],
        transferUnits: [],
        executionOptions: { copy: {}, config: {}, filter: {}, remotes: {} },
    }
}

describe('Copy + Verify history retention', () => {
    it('keeps the exact 90-day boundary and unfinished work', () => {
        const now = Date.parse('2026-08-17T00:00:00.000Z')
        const boundary = new Date(now - COPY_VERIFY_RETENTION_MS).toISOString()
        const retained = operation(
            'retained',
            'complete',
            new Date(now - COPY_VERIFY_RETENTION_MS + 1).toISOString()
        )
        const expired = operation('expired', 'complete', boundary)
        const active = operation('active', 'verifying', boundary)
        const required = operation('required', 'verification_required', boundary)

        expect(
            pruneTerminalOperations([retained, expired, active, required], now).map(
                (item) => item.id
            )
        ).toEqual(['retained', 'active'])
    })
})
