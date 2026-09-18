import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { downloadTo } from '../lib/install.js'

// A local server plays the release host: every way the transfer can go wrong must reject the
// promise and leave no partial file behind.
function serve(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler)
        server.listen(0, '127.0.0.1', () =>
            resolve({
                url: `http://127.0.0.1:${server.address().port}`,
                close: () => new Promise((done) => server.close(done)),
            })
        )
    })
}

const target = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcui-cli-')), 'installer.bin')

test('a redirect loop rejects', async () => {
    const { url, close } = await serve((req, res) => {
        res.writeHead(302, { location: '/again' })
        res.end()
    })
    const file = target()
    try {
        await assert.rejects(downloadTo(`${url}/start`, file, { get: http.get }), /redirects/)
        assert.equal(fs.existsSync(file), false)
    } finally {
        await close()
    }
})

test('a server error rejects', async () => {
    const { url, close } = await serve((req, res) => {
        res.writeHead(500)
        res.end('no')
    })
    const file = target()
    try {
        await assert.rejects(downloadTo(url, file, { get: http.get }), /500/)
        assert.equal(fs.existsSync(file), false)
    } finally {
        await close()
    }
})

test('a dropped connection rejects and removes the partial file', async () => {
    const { url, close } = await serve((req, res) => {
        res.writeHead(200, { 'content-length': '100' })
        res.write('partial')
        setTimeout(() => res.destroy(), 20)
    })
    const file = target()
    try {
        await assert.rejects(downloadTo(url, file, { get: http.get }))
        assert.equal(fs.existsSync(file), false)
    } finally {
        await close()
    }
})

test('a refused connection rejects', async () => {
    const file = target()
    await assert.rejects(downloadTo('http://127.0.0.1:1/x', file, { get: http.get }))
    assert.equal(fs.existsSync(file), false)
})

test('a complete download resolves with the file', async () => {
    const { url, close } = await serve((req, res) => {
        if (req.url === '/start') {
            res.writeHead(302, { location: '/file' })
            res.end()
            return
        }
        res.writeHead(200, { 'content-length': '5' })
        res.end('hello')
    })
    const file = target()
    const progress = []
    try {
        const saved = await downloadTo(`${url}/start`, file, {
            get: http.get,
            onProgress: (done, total) => progress.push([done, total]),
        })
        assert.equal(saved, file)
        assert.equal(fs.readFileSync(file, 'utf8'), 'hello')
        assert.deepEqual(progress.at(-1), [5, 5])
    } finally {
        await close()
    }
})

// A launcher's failure must be observed, not reported as a successful open.
test('a launcher that exits with an error rejects', async () => {
    const { settleLaunch } = await import('../lib/open.js')
    const child = new EventEmitter()
    child.unref = () => {}
    const launched = new Promise((resolve, reject) => settleLaunch(child, resolve, reject, 200))
    child.emit('exit', 1)
    await assert.rejects(launched, /exited with code 1/)
})

test('a launcher still running after the grace period counts as opened', async () => {
    const { settleLaunch } = await import('../lib/open.js')
    const child = new EventEmitter()
    child.unref = () => {}
    await new Promise((resolve, reject) => settleLaunch(child, resolve, reject, 50))
})
