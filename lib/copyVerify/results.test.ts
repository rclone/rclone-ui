import { describe, expect, it } from 'vitest'
import type { TransferUnit } from '../../types/copyVerify'
import {
    aggregateCopyResult,
    aggregateVerificationResult,
    classifyVerificationMethod,
    recoverFilesChecked,
} from './results'

const units: TransferUnit[] = [
    {
        id: 'unit-1',
        kind: 'folder',
        sourceDisplayPath: '/source/',
        destinationDisplayPath: '/destination/source',
        copyInput: { _path: 'sync/copy' },
        verificationInput: { _path: 'operations/check' },
    },
]

describe('Copy + Verify result aggregation', () => {
    it('requires every copy child to succeed', () => {
        const result = aggregateCopyResult(
            {
                finished: true,
                output: { results: [{ success: true }, { error: 'permission denied' }] },
            },
            2,
            [units[0], { ...units[0], id: 'unit-2' }]
        )

        expect(result.success).toBe(false)
        expect(result.errors[0]).toMatchObject({ unitId: 'unit-2', message: 'permission denied' })
    })

    it('rejects incomplete copy output even when the job says success', () => {
        const result = aggregateCopyResult(
            { finished: true, success: true, output: { results: [{ success: true }] } },
            2,
            [units[0], { ...units[0], id: 'unit-2' }]
        )
        expect(result.success).toBe(false)
        expect(result.message).toContain('returned 1 results')
    })

    it('rejects malformed copy children instead of inferring success', () => {
        const result = aggregateCopyResult({ finished: true, output: { results: [{}] } }, 1, units)

        expect(result.success).toBe(false)
        expect(result.errors[0]).toMatchObject({
            unitId: 'unit-1',
            message: 'Copy child did not report success',
        })
    })

    it.each([
        [['md5'], 'checksum'],
        [['none'], 'size_only'],
        [['md5', 'none'], 'mixed'],
        [[undefined, 'md5'], 'unknown'],
    ])('classifies hash coverage %#', (hashTypes, expected) => {
        expect(classifyVerificationMethod(hashTypes as Array<string | undefined>).kind).toBe(
            expected
        )
    })

    it('aggregates missing, differing, and read errors with unit context', () => {
        const result = aggregateVerificationResult(
            {
                finished: true,
                output: {
                    results: [
                        {
                            output: {
                                success: false,
                                hashType: 'md5',
                                missingOnDst: ['missing.txt'],
                                differ: ['changed.txt'],
                                error: ['unreadable.txt'],
                            },
                        },
                    ],
                },
            },
            units
        )

        expect(result.success).toBe(false)
        expect(result.method.kind).toBe('checksum')
        expect(result.missingFiles).toEqual([{ unitId: 'unit-1', path: 'missing.txt' }])
        expect(result.differentFiles).toEqual([{ unitId: 'unit-1', path: 'changed.txt' }])
        expect(result.errors).toEqual([{ unitId: 'unit-1', path: 'unreadable.txt' }])
    })

    it('does not turn missing or differing files into generic read errors', () => {
        const result = aggregateVerificationResult(
            {
                finished: true,
                output: {
                    results: [
                        {
                            output: {
                                success: false,
                                hashType: 'md5',
                                missingOnDst: ['missing.txt'],
                                differ: ['changed.txt'],
                            },
                        },
                    ],
                },
            },
            units
        )

        expect(result.errors).toEqual([])
        expect(result.success).toBe(false)
    })

    it('does not invent a checked-file count', () => {
        expect(recoverFilesChecked({ checks: 12 })).toBe(12)
        expect(recoverFilesChecked({ checks: '12' })).toBeNull()
        expect(recoverFilesChecked({})).toBeNull()
    })
})
