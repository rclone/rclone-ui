import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
    const server = createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    return port
}

async function waitForRclone(baseUrl) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const response = await fetch(`${baseUrl}/core/version`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
            })
            if (response.ok) return
        } catch {}
        await wait(100)
    }
    throw new Error('Timed out waiting for the temporary rclone rcd')
}

async function post(baseUrl, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    const data = await response.json()
    if (!response.ok || data.error) throw new Error(`${path}: ${data.error ?? response.statusText}`)
    return data
}

async function runJob(baseUrl, inputs, group) {
    const submitted = await post(baseUrl, '/job/batch', {
        inputs: inputs.map((input) => ({ ...input, _group: group })),
        _async: true,
    })
    assert.equal(typeof submitted.jobid, 'number')
    assert.equal(typeof submitted.executeId, 'string')

    for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = await post(baseUrl, '/job/status', { jobid: submitted.jobid })
        assert.equal(status.executeId, submitted.executeId)
        if (status.finished) return { submitted, status }
        await wait(25)
    }
    throw new Error(`Job ${submitted.jobid} did not finish`)
}

function localFs(path) {
    return `:local:${path}`
}

function copyInput(src, dst) {
    return { _path: 'sync/copy', srcFs: `${localFs(src)}/`, dstFs: `${localFs(dst)}/` }
}

function checkInput(src, dst, filter) {
    return {
        _path: 'operations/check',
        srcFs: `${localFs(src)}/`,
        dstFs: `${localFs(dst)}/`,
        oneWay: true,
        missingOnDst: true,
        differ: true,
        error: true,
        match: false,
        ...(filter ? { _filter: JSON.stringify({ IncludeRule: [filter] }) } : {}),
    }
}

async function main() {
    const root = await mkdtemp(join(tmpdir(), 'rclone-copy-verify-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    const reservedSource = join(root, 'reserved-source')
    const reservedDestination = join(root, 'reserved-destination')
    await mkdir(source)
    await mkdir(destination)
    await mkdir(reservedSource)
    await mkdir(reservedDestination)
    await writeFile(join(source, 'a.txt'), 'same')
    await writeFile(join(source, 'changed.txt'), 'source')
    await writeFile(join(reservedSource, 'reserved[1]*?.txt'), 'reserved')

    const port = await freePort()
    const child = spawn(
        'rclone',
        [
            'rcd',
            '--rc-no-auth',
            '--rc-addr',
            `127.0.0.1:${port}`,
            '--rc-job-expire-duration',
            '2m',
            '--rc-job-expire-interval',
            '30s',
        ],
        { stdio: 'ignore' }
    )
    const baseUrl = `http://127.0.0.1:${port}`

    try {
        await waitForRclone(baseUrl)
        const firstCopy = await runJob(baseUrl, [copyInput(source, destination)], 'copy-verify/test/copy')
        assert.equal(firstCopy.status.success, true)

        const verified = await runJob(
            baseUrl,
            [checkInput(source, destination)],
            'copy-verify/test/verify/1'
        )
        const verifiedResult = verified.status.output.results[0]
        assert.equal(verifiedResult.success, true)
        assert.equal(verifiedResult.hashType, 'md5')

        await writeFile(join(destination, 'extra.txt'), 'ignored by one-way')
        const extraPass = await runJob(
            baseUrl,
            [checkInput(source, destination)],
            'copy-verify/test/verify/extra'
        )
        assert.equal(extraPass.status.output.results[0].success, true)

        await rm(join(destination, 'a.txt'))
        const missing = await runJob(
            baseUrl,
            [checkInput(source, destination)],
            'copy-verify/test/verify/missing'
        )
        assert.deepEqual(missing.status.output.results[0].missingOnDst, ['a.txt'])

        await writeFile(join(destination, 'a.txt'), 'same')
        await writeFile(join(destination, 'changed.txt'), 'different')
        const differing = await runJob(
            baseUrl,
            [checkInput(source, destination)],
            'copy-verify/test/verify/differ'
        )
        assert.deepEqual(differing.status.output.results[0].differ, ['changed.txt'])

        const reservedCopy = await runJob(
            baseUrl,
            [
                {
                    _path: 'operations/copyfile',
                    srcFs: localFs(reservedSource),
                    srcRemote: 'reserved[1]*?.txt',
                    dstFs: localFs(reservedDestination),
                    dstRemote: 'reserved[1]*?.txt',
                },
            ],
            'copy-verify/test/file/copy'
        )
        assert.equal(reservedCopy.status.success, true)
        const reservedCheck = await runJob(
            baseUrl,
            [checkInput(reservedSource, reservedDestination, '/reserved\\[1\\]\\*\\?.txt')],
            'copy-verify/test/file/verify'
        )
        assert.equal(reservedCheck.status.output.results[0].success, true)

        const repair = await runJob(
            baseUrl,
            [
                {
                    _path: 'operations/copyfile',
                    srcFs: localFs(source),
                    srcRemote: 'changed.txt',
                    dstFs: localFs(destination),
                    dstRemote: 'changed.txt',
                    _config: JSON.stringify({ IgnoreExisting: false, Immutable: false, IgnoreTimes: true }),
                },
            ],
            'copy-verify/test/repair/1'
        )
        assert.equal(repair.status.success, true)
        const repairedCheck = await runJob(
            baseUrl,
            [checkInput(source, destination)],
            'copy-verify/test/verify/repaired'
        )
        assert.equal(repairedCheck.status.output.results[0].success, true)

        console.log('local Copy + Verify rclone integration passed')
    } finally {
        child.kill('SIGTERM')
        await rm(root, { recursive: true, force: true })
    }
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
