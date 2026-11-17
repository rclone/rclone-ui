import type { BatchInput, CopyArgs } from '../lib/rclone/requests'

export type VerificationMethod =
    | { kind: 'checksum'; hashTypes: string[] }
    | { kind: 'size_only'; hashTypes: [] }
    | { kind: 'mixed'; hashTypes: string[] }
    | { kind: 'unknown'; hashTypes: string[] }

export interface TransferUnit {
    id: string
    kind: 'file' | 'folder'
    sourceDisplayPath: string
    destinationDisplayPath: string
    copyInput: BatchInput
    verificationInput: BatchInput
}

export interface CopyVerifyPlan {
    units: TransferUnit[]
    copyInputs: BatchInput[]
    verificationInputs: BatchInput[]
}

export type CopyVerifyPhase =
    | 'submitting_copy'
    | 'copying'
    | 'submitting_verification'
    | 'verifying'
    | 'repairing'
    | 'verification_required'
    | 'complete'

export type CopyVerifyResult =
    | 'verified'
    | 'verified_with_limitations'
    | 'copy_failed'
    | 'verification_failed'
    | 'cancelled'
    | null

export interface RcloneJobRef {
    jobId: number
    executeId: string
    group: string
    attempt: number
    startedAt: string
    finishedAt?: string
}

export interface VerificationIssue {
    unitId: string
    path: string
    message?: string
}

export interface CopyVerifyOperation {
    id: string
    hostId: string
    sources: string[]
    destination: string
    createdAt: string
    updatedAt: string
    completedAt?: string

    phase: CopyVerifyPhase
    result: CopyVerifyResult
    verificationMethod?: VerificationMethod
    filesChecked: number | null

    missingFiles: VerificationIssue[]
    differentFiles: VerificationIssue[]
    errors: VerificationIssue[]

    copyDurationSeconds?: number
    verificationDurationSeconds?: number
    totalDurationSeconds?: number

    copyJob?: RcloneJobRef
    verificationJobs: RcloneJobRef[]
    repairJobs: RcloneJobRef[]

    transferUnits: TransferUnit[]
    executionOptions: CopyArgs['options']
}

export type CopyVerifyUpdate = Partial<Omit<CopyVerifyOperation, 'id' | 'hostId' | 'createdAt'>>

export function isCopyVerifyTerminal(operation: CopyVerifyOperation): boolean {
    return operation.phase === 'complete' || operation.phase === 'verification_required'
}
