import type { CopyVerifyOperation, VerificationIssue } from '../../types/copyVerify'

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&')
}

function renderIssues(title: string, issues: VerificationIssue[]): string[] {
    const lines = [`### ${title}`]
    if (issues.length === 0) {
        lines.push('None')
        return lines
    }
    for (const issue of issues) {
        lines.push(
            `- \`${escapeMarkdown(issue.unitId)}\` — \`${escapeMarkdown(issue.path)}\`${issue.message ? ` — ${escapeMarkdown(issue.message)}` : ''}`
        )
    }
    return lines
}

function formatDuration(seconds: number | undefined): string {
    return seconds === undefined ? 'Unavailable' : `${seconds.toFixed(2)} seconds`
}

function renderJobRefs(operation: CopyVerifyOperation): string[] {
    const lines = ['### Job references']
    if (operation.copyJob) {
        lines.push(
            `- Copy: job ${operation.copyJob.jobId}, group \`${escapeMarkdown(operation.copyJob.group)}\`, attempt ${operation.copyJob.attempt}`
        )
    }
    for (const job of operation.verificationJobs) {
        lines.push(
            `- Verification: job ${job.jobId}, group \`${escapeMarkdown(job.group)}\`, attempt ${job.attempt}`
        )
    }
    for (const job of operation.repairJobs) {
        lines.push(
            `- Repair: job ${job.jobId}, group \`${escapeMarkdown(job.group)}\`, attempt ${job.attempt}`
        )
    }
    if (lines.length === 1) lines.push('Unavailable')
    return lines
}

export function verificationMethodLabel(operation: CopyVerifyOperation): string {
    const method = operation.verificationMethod
    if (!method) return 'Unavailable'
    if (method.kind === 'checksum') {
        return `Checksum (${method.hashTypes.join(', ') || 'rclone-reported'}) — rclone-reported`
    }
    if (method.kind === 'size_only') return 'Size only — rclone-reported'
    if (method.kind === 'mixed') {
        return `Mixed checksum/size-only (${method.hashTypes.join(', ') || 'rclone-reported'}) — rclone-reported`
    }
    return `Unknown method (${method.hashTypes.join(', ') || 'not reported'}) — rclone-reported`
}

export function buildCopyReport(operation: CopyVerifyOperation): string {
    const result = operation.result
        ? operation.result.replace(/_/g, ' ').toUpperCase()
        : 'IN PROGRESS'
    const lines = [
        '# Copy + Verify report',
        '',
        `- Operation ID: \`${escapeMarkdown(operation.id)}\``,
        `- Result: ${escapeMarkdown(result)}`,
        `- Phase: ${escapeMarkdown(operation.phase)}`,
        `- Created: ${escapeMarkdown(operation.createdAt)}`,
        `- Updated: ${escapeMarkdown(operation.updatedAt)}`,
        `- Completed: ${operation.completedAt ? escapeMarkdown(operation.completedAt) : 'Not completed'}`,
        `- Sources: ${operation.sources.map((source) => `\`${escapeMarkdown(source)}\``).join(', ')}`,
        `- Destination: \`${escapeMarkdown(operation.destination)}\``,
        `- Verification method: ${escapeMarkdown(verificationMethodLabel(operation))}`,
        `- Files checked: ${operation.filesChecked === null ? 'Unavailable' : operation.filesChecked}`,
        `- Copy duration: ${formatDuration(operation.copyDurationSeconds)}`,
        `- Verification duration: ${formatDuration(operation.verificationDurationSeconds)}`,
        `- Total duration: ${formatDuration(operation.totalDurationSeconds)}`,
        '',
        ...renderJobRefs(operation),
        '',
        ...renderIssues('Missing files', operation.missingFiles),
        '',
        ...renderIssues('Different files', operation.differentFiles),
        '',
        ...renderIssues('Errors', operation.errors),
    ]
    return lines.join('\n')
}
