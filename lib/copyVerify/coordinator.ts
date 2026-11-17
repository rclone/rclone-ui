import { getCurrentWindow } from '@tauri-apps/api/window'
import { flushHostStore, useHostStore } from '../../store/host'
import { selectCurrentHost, usePersistedStore } from '../../store/persisted'
import type {
    CopyVerifyOperation,
    CopyVerifyUpdate,
    RcloneJobRef,
    TransferUnit,
} from '../../types/copyVerify'
import {
    COPY_VERIFY_ACK,
    COPY_VERIFY_COMMAND,
    COPY_VERIFY_UPDATED,
    type CopyVerifyCommand,
} from '../events'
import type { CopyArgs } from '../rclone/requests'
import { buildCopyVerifyPlan } from './planner'
import {
    type SubmittedCopyVerifyJob,
    getGroupStats,
    getJobList,
    stopCopyVerifyGroup,
    submitCopyVerifyBatch,
    waitForCopyVerifyJob,
} from './rclone'
import { buildRepairInputs } from './repair'
import { buildCopyReport } from './report'
import { aggregateCopyResult, aggregateVerificationResult, recoverFilesChecked } from './results'

const COPY_VERIFY_GROUP_PREFIX = 'copy-verify'

function nowIso(): string {
    return new Date().toISOString()
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function durationSince(startedAt: string): number | undefined {
    const started = Date.parse(startedAt)
    if (!Number.isFinite(started)) return undefined
    return Math.max(0, (Date.now() - started) / 1000)
}

function makeJobRef(
    submitted: SubmittedCopyVerifyJob,
    group: string,
    attempt: number
): RcloneJobRef {
    return {
        jobId: submitted.jobId,
        executeId: submitted.executeId,
        group,
        attempt,
        startedAt: nowIso(),
    }
}

function appendIssues<T>(current: T[], additions: T[]): T[] {
    return [...current, ...additions]
}

export class CopyVerifyCoordinator {
    private readonly controllers = new Map<string, AbortController>()
    private unlisten: (() => void) | undefined

    async start(): Promise<void> {
        const window = getCurrentWindow()
        this.unlisten = await window.listen<CopyVerifyCommand>(COPY_VERIFY_COMMAND, (event) => {
            this.handleCommand(event.payload).catch((error) =>
                console.error('[CopyVerify] command failed', error)
            )
        })

        const hostStore = useHostStore.getState()
        hostStore.pruneCopyVerifyOperations()
        await flushHostStore()
        await this.reconcile()
    }

    dispose(): void {
        this.unlisten?.()
        this.unlisten = undefined
        for (const controller of this.controllers.values()) controller.abort()
        this.controllers.clear()
    }

    private async emitAck(payload: {
        requestId: string
        ok: boolean
        operationId?: string
        error?: string
    }): Promise<void> {
        await getCurrentWindow().emit(COPY_VERIFY_ACK, payload)
    }

    private async publish(operation: CopyVerifyOperation): Promise<void> {
        await getCurrentWindow().emit(COPY_VERIFY_UPDATED, operation)
    }

    private async update(id: string, patch: CopyVerifyUpdate): Promise<CopyVerifyOperation> {
        const hostStore = useHostStore.getState()
        hostStore.updateCopyVerifyOperation(id, patch)
        await flushHostStore()
        const operation = useHostStore
            .getState()
            .copyVerifyOperations.find((item) => item.id === id)
        if (!operation) throw new Error(`Copy + Verify operation ${id} no longer exists`)
        await this.publish(operation)
        return operation
    }

    private getOperation(id: string): CopyVerifyOperation {
        const operation = useHostStore
            .getState()
            .copyVerifyOperations.find((item) => item.id === id)
        if (!operation) throw new Error(`Copy + Verify operation ${id} was not found`)
        return operation
    }

    private currentHostId(): string {
        const hostId = usePersistedStore.getState().currentHostId
        if (!hostId) throw new Error('No rclone host is selected')
        if (!selectCurrentHost(usePersistedStore.getState())) {
            throw new Error('The selected rclone host is unavailable')
        }
        return hostId
    }

    private controllerFor(id: string): AbortController {
        const existing = this.controllers.get(id)
        if (existing) return existing
        const controller = new AbortController()
        this.controllers.set(id, controller)
        return controller
    }

    private async handleCommand(command: CopyVerifyCommand): Promise<void> {
        try {
            if (command.type === 'start') {
                const operationId = await this.startCopy(command.args)
                await this.emitAck({ requestId: command.requestId, ok: true, operationId })
                return
            }
            if (command.type === 'repair') {
                await this.startRepair(command.operationId)
                await this.emitAck({ requestId: command.requestId, ok: true })
                return
            }
            if (command.type === 'verify-again') {
                await this.startVerification(command.operationId)
                await this.emitAck({ requestId: command.requestId, ok: true })
                return
            }
            await this.stop(command.operationId)
            await this.emitAck({ requestId: command.requestId, ok: true })
        } catch (error) {
            await this.emitAck({
                requestId: command.requestId,
                ok: false,
                error: errorMessage(error),
            })
        }
    }

    private async startCopy(args: CopyArgs): Promise<string> {
        const hostId = this.currentHostId()
        const plan = buildCopyVerifyPlan(args)
        if (plan.units.length === 0) throw new Error('Select at least one source path')

        const operationId = crypto.randomUUID()
        const createdAt = nowIso()
        const operation: CopyVerifyOperation = {
            id: operationId,
            hostId,
            sources: [...args.sources],
            destination: args.destination,
            createdAt,
            updatedAt: createdAt,
            phase: 'submitting_copy',
            result: null,
            filesChecked: null,
            missingFiles: [],
            differentFiles: [],
            errors: [],
            verificationJobs: [],
            repairJobs: [],
            transferUnits: plan.units,
            executionOptions: args.options,
        }
        useHostStore.getState().addCopyVerifyOperation(operation)
        await flushHostStore()
        await this.publish(operation)

        const controller = this.controllerFor(operationId)
        try {
            const group = `${COPY_VERIFY_GROUP_PREFIX}/${operationId}/copy`
            const submitted = await submitCopyVerifyBatch(plan.copyInputs, group)
            const copyJob = makeJobRef(submitted, group, 1)
            await this.update(operationId, { phase: 'copying', copyJob })
            this.processCopy(operationId, submitted, controller).catch((error) =>
                console.error('[CopyVerify] copy processing failed', error)
            )
            return operationId
        } catch (error) {
            await this.update(operationId, {
                phase: 'complete',
                result: 'copy_failed',
                completedAt: nowIso(),
                totalDurationSeconds: durationSince(createdAt),
                errors: [{ unitId: 'operation', path: 'copy', message: errorMessage(error) }],
            })
            this.controllers.delete(operationId)
            throw error
        }
    }

    private async processCopy(
        operationId: string,
        submitted: SubmittedCopyVerifyJob,
        controller: AbortController
    ): Promise<void> {
        try {
            const operation = this.getOperation(operationId)
            const status = await waitForCopyVerifyJob(submitted, { signal: controller.signal })
            const aggregate = aggregateCopyResult(
                status,
                operation.transferUnits.length,
                operation.transferUnits
            )
            const copyDurationSeconds = status.duration ?? durationSince(operation.createdAt)
            if (!aggregate.success) {
                await this.update(operationId, {
                    phase: 'complete',
                    result: 'copy_failed',
                    completedAt: nowIso(),
                    copyDurationSeconds,
                    totalDurationSeconds: durationSince(operation.createdAt),
                    errors: appendIssues(operation.errors, aggregate.errors),
                })
                this.controllers.delete(operationId)
                return
            }
            await this.update(operationId, { copyDurationSeconds })
            await this.startVerification(operationId, controller)
        } catch (error) {
            const current = this.getOperation(operationId)
            if (current.phase === 'complete' || controller.signal.aborted) return
            await this.markVerificationRequired(operationId, error)
        }
    }

    private async startVerification(
        operationId: string,
        controller = this.controllerFor(operationId)
    ): Promise<void> {
        const operation = this.getOperation(operationId)
        if (operation.hostId !== this.currentHostId()) {
            throw new Error('Switch back to the operation host before verifying')
        }
        const attempt = operation.verificationJobs.length + 1
        const group = `${COPY_VERIFY_GROUP_PREFIX}/${operationId}/verify/${attempt}`
        await this.update(operationId, {
            phase: 'submitting_verification',
            result: null,
            missingFiles: [],
            differentFiles: [],
            errors: [],
        })

        try {
            const submitted = await submitCopyVerifyBatch(
                operation.transferUnits.map((unit) => unit.verificationInput),
                group
            )
            const verificationJob = makeJobRef(submitted, group, attempt)
            await this.update(operationId, {
                phase: 'verifying',
                verificationJobs: [...operation.verificationJobs, verificationJob],
            })
            this.processVerification(operationId, submitted, verificationJob, controller).catch(
                (error) => console.error('[CopyVerify] verification processing failed', error)
            )
        } catch (error) {
            await this.markVerificationRequired(operationId, error)
            throw error
        }
    }

    private async processVerification(
        operationId: string,
        submitted: SubmittedCopyVerifyJob,
        verificationJob: RcloneJobRef,
        controller: AbortController
    ): Promise<void> {
        try {
            const operation = this.getOperation(operationId)
            const status = await waitForCopyVerifyJob(submitted, { signal: controller.signal })
            let filesChecked: number | null = null
            try {
                filesChecked = recoverFilesChecked(await getGroupStats(verificationJob.group))
            } catch (error) {
                console.warn('[CopyVerify] files checked unavailable', errorMessage(error))
            }
            const aggregate = aggregateVerificationResult(status, operation.transferUnits)
            const method = aggregate.method
            const result = aggregate.success
                ? method.kind === 'checksum'
                    ? 'verified'
                    : 'verified_with_limitations'
                : 'verification_failed'
            const completedAt = nowIso()
            await this.update(operationId, {
                phase: 'complete',
                result,
                completedAt,
                verificationMethod: method,
                filesChecked,
                missingFiles: aggregate.missingFiles,
                differentFiles: aggregate.differentFiles,
                errors: aggregate.errors,
                verificationDurationSeconds:
                    status.duration ?? durationSince(verificationJob.startedAt),
                totalDurationSeconds: durationSince(operation.createdAt),
                verificationJobs: operation.verificationJobs.map((job) =>
                    job.jobId === verificationJob.jobId ? { ...job, finishedAt: completedAt } : job
                ),
            })
            this.controllers.delete(operationId)
        } catch (error) {
            const current = this.getOperation(operationId)
            if (current.phase === 'complete' || controller.signal.aborted) return
            await this.markVerificationRequired(operationId, error)
        }
    }

    private async startRepair(operationId: string): Promise<void> {
        const operation = this.getOperation(operationId)
        if (operation.result !== 'verification_failed') {
            throw new Error('Repair is only available after a verification failure')
        }
        if (operation.missingFiles.length === 0 && operation.differentFiles.length === 0) {
            throw new Error('There are no missing or differing files to repair')
        }
        if (operation.hostId !== this.currentHostId()) {
            throw new Error('Switch back to the operation host before repairing')
        }

        const repair = buildRepairInputs(operation)
        const controller = this.controllerFor(operationId)
        const attempt = operation.repairJobs.length + 1
        const group = `${COPY_VERIFY_GROUP_PREFIX}/${operationId}/repair/${attempt}`
        await this.update(operationId, { phase: 'repairing', result: null })

        try {
            const submitted = await submitCopyVerifyBatch(repair.inputs, group)
            const repairJob = makeJobRef(submitted, group, attempt)
            await this.update(operationId, {
                phase: 'repairing',
                repairJobs: [...operation.repairJobs, repairJob],
            })
            this.processRepair(operationId, submitted, repairJob, repair.units, controller).catch(
                (error) => console.error('[CopyVerify] repair processing failed', error)
            )
        } catch (error) {
            await this.markVerificationRequired(operationId, error)
            throw error
        }
    }

    private async processRepair(
        operationId: string,
        submitted: SubmittedCopyVerifyJob,
        repairJob: RcloneJobRef,
        units: TransferUnit[],
        controller: AbortController
    ): Promise<void> {
        try {
            const operation = this.getOperation(operationId)
            const status = await waitForCopyVerifyJob(submitted, { signal: controller.signal })
            const aggregate = aggregateCopyResult(status, units.length, units)
            if (!aggregate.success) {
                await this.update(operationId, {
                    phase: 'complete',
                    result: 'verification_failed',
                    completedAt: nowIso(),
                    errors: appendIssues(operation.errors, aggregate.errors),
                    repairJobs: operation.repairJobs.map((job) =>
                        job.jobId === repairJob.jobId ? { ...job, finishedAt: nowIso() } : job
                    ),
                })
                this.controllers.delete(operationId)
                return
            }
            await this.update(operationId, {
                repairJobs: operation.repairJobs.map((job) =>
                    job.jobId === repairJob.jobId ? { ...job, finishedAt: nowIso() } : job
                ),
            })
            await this.startVerification(operationId, controller)
        } catch (error) {
            const current = this.getOperation(operationId)
            if (current.phase === 'complete' || controller.signal.aborted) return
            await this.markVerificationRequired(operationId, error)
        }
    }

    private async markVerificationRequired(operationId: string, error: unknown): Promise<void> {
        const operation = this.getOperation(operationId)
        if (operation.phase === 'complete' || operation.phase === 'verification_required') return
        await this.update(operationId, {
            phase: 'verification_required',
            result: null,
            completedAt: undefined,
            errors: appendIssues(operation.errors, [
                { unitId: 'operation', path: 'recovery', message: errorMessage(error) },
            ]),
        })
    }

    private async stop(operationId: string): Promise<void> {
        const operation = this.getOperation(operationId)
        if (operation.phase === 'complete' || operation.phase === 'verification_required') {
            throw new Error('This Copy + Verify operation is not running')
        }
        const controller = this.controllers.get(operationId)
        controller?.abort()
        const job =
            operation.phase === 'copying'
                ? operation.copyJob
                : operation.phase === 'repairing'
                  ? operation.repairJobs.at(-1)
                  : operation.verificationJobs.at(-1)
        if (job) await stopCopyVerifyGroup(job.group).catch(() => undefined)

        if (operation.phase === 'copying' || operation.phase === 'submitting_copy') {
            await this.update(operationId, {
                phase: 'complete',
                result: 'cancelled',
                completedAt: nowIso(),
                totalDurationSeconds: durationSince(operation.createdAt),
            })
        } else {
            await this.update(operationId, {
                phase: 'verification_required',
                result: null,
                errors: appendIssues(operation.errors, [
                    {
                        unitId: 'operation',
                        path: 'stop',
                        message: 'Stopped before verification completed',
                    },
                ]),
            })
        }
        this.controllers.delete(operationId)
    }

    private async reconcile(): Promise<void> {
        const hostId = usePersistedStore.getState().currentHostId
        if (!hostId) return
        const operations = useHostStore
            .getState()
            .copyVerifyOperations.filter(
                (operation) =>
                    operation.hostId === hostId &&
                    !['complete', 'verification_required'].includes(operation.phase)
            )
        if (operations.length === 0) return

        const jobs = await getJobList().catch(() => null)
        if (!jobs) {
            for (const operation of operations) {
                await this.markVerificationRequired(
                    operation.id,
                    'Unable to reconcile rclone jobs after restart'
                )
            }
            return
        }

        for (const operation of operations) {
            const job =
                operation.phase === 'copying'
                    ? operation.copyJob
                    : operation.phase === 'repairing'
                      ? operation.repairJobs.at(-1)
                      : operation.verificationJobs.at(-1)
            if (!job || job.executeId !== jobs.executeId || !jobs.jobids.includes(job.jobId)) {
                await this.markVerificationRequired(
                    operation.id,
                    'The submitted rclone job could not be reattached'
                )
                continue
            }
            const controller = this.controllerFor(operation.id)
            const submitted = { jobId: job.jobId, executeId: job.executeId }
            if (operation.phase === 'copying' && operation.copyJob) {
                this.processCopy(operation.id, submitted, controller).catch((error) =>
                    console.error('[CopyVerify] recovery copy failed', error)
                )
            } else if (operation.phase === 'repairing' && operation.repairJobs.at(-1)) {
                const repair = buildRepairInputs(operation)
                this.processRepair(
                    operation.id,
                    submitted,
                    operation.repairJobs.at(-1)!,
                    repair.units,
                    controller
                ).catch((error) => console.error('[CopyVerify] recovery repair failed', error))
            } else if (operation.phase === 'verifying' && operation.verificationJobs.at(-1)) {
                this.processVerification(
                    operation.id,
                    submitted,
                    operation.verificationJobs.at(-1)!,
                    controller
                ).catch((error) =>
                    console.error('[CopyVerify] recovery verification failed', error)
                )
            } else {
                await this.markVerificationRequired(
                    operation.id,
                    'Operation was interrupted before a job reference was saved'
                )
            }
        }
    }

    copyReport(operationId: string): string {
        return buildCopyReport(this.getOperation(operationId))
    }

    async markDaemonRestarted(): Promise<void> {
        await this.markActiveOperationsRequired('The rclone daemon was restarted')
    }

    async markHostChanged(): Promise<void> {
        await this.markActiveOperationsRequired('The rclone host changed')
    }

    private async markActiveOperationsRequired(message: string): Promise<void> {
        const active = useHostStore
            .getState()
            .copyVerifyOperations.filter(
                (operation) => !['complete', 'verification_required'].includes(operation.phase)
            )
        for (const operation of active) {
            await this.markVerificationRequired(operation.id, message)
        }
    }
}

export async function initCopyVerifyCoordinator(): Promise<CopyVerifyCoordinator> {
    const coordinator = new CopyVerifyCoordinator()
    await coordinator.start()
    return coordinator
}
