'use strict';

const crypto = require('crypto');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { runCoverJob } = require('./coverBackendRunner.cjs');
const {
    PHASE_RANK,
    audioExt,
    isEncryptedAudio,
    isOrdinaryAudio,
    mapOkcError,
    progressFromLine,
} = require('./coverProtocol.cjs');

// electron/cover/coverJobs.cjs
// 翻唱任务队列：一次一个，进度只增不减，成功后把作品夹移入输出根，失败和启动时清掉 .processing。

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LYRICS_FORMATS = new Set(['lrc', 'krc', 'vtt', 'ttml', 'yrc', 'qrc']);
const MODES = new Set(['library', 'normal', 'aggressive']);
const SEPARATORS = new Set(['builtin', 'msst-native']);
const COVER_ROOT_ID = 'root-cover';

function ok(value) {
    return { ok: true, value };
}

function fail(code, detail) {
    return detail ? { ok: false, code, detail } : { ok: false, code };
}

function copyBytes(value) {
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
}

function workBaseName(artist, title) {
    const titleText = typeof title === 'string' ? title.trim() : '';
    const artistText = typeof artist === 'string' ? artist.trim() : '';
    const raw = artistText ? `${artistText} - ${titleText}` : titleText;
    const cleaned = raw
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '')
        .trim();
    if (!cleaned || cleaned === '.' || cleaned === '..') return null;
    return cleaned.slice(0, 80);
}

function coverWorkId(relPath) {
    return crypto.createHash('sha256').update(`${COVER_ROOT_ID}\0${relPath}`).digest('hex').slice(0, 16);
}

function hashFile(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function defaultCheckGpu() {
    return new Promise((resolve) => {
        execFile('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], {
            timeout: 3000,
            windowsHide: true,
        }, (error, stdout) => {
            if (error) {
                resolve({ ok: false, name: null, reason: 'no-nvidia' });
                return;
            }
            const line = String(stdout).split(/\r?\n/).map(item => item.trim()).find(Boolean);
            const name = line ? line.split(',')[0].trim() : '';
            if (!name) {
                resolve({ ok: false, name: null, reason: 'no-nvidia' });
                return;
            }
            resolve({ ok: true, name });
        });
    });
}

function validateRequest(req) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) return fail('INVALID_REQUEST');
    if (typeof req.sourceSongId !== 'string' || req.sourceSongId.length === 0 || req.sourceSongId.length > 256) {
        return fail('INVALID_REQUEST');
    }
    if (!req.source || typeof req.source.fileName !== 'string' || req.source.fileName.length === 0 || req.source.fileName.length > 512) {
        return fail('INVALID_REQUEST');
    }
    const bytes = copyBytes(req.source.bytes);
    if (!bytes || bytes.length === 0) return fail('INVALID_REQUEST');
    if (typeof req.modelId !== 'string' || !MODEL_ID.test(req.modelId)) return fail('INVALID_REQUEST');
    if (typeof req.title !== 'string' || req.title.trim().length === 0 || req.title.length > 200) return fail('INVALID_REQUEST');
    if (req.artist !== null && req.artist !== undefined && typeof req.artist !== 'string') return fail('INVALID_REQUEST');
    if (typeof req.artist === 'string' && req.artist.length > 200) return fail('INVALID_REQUEST');
    if (req.lyrics !== null && req.lyrics !== undefined) {
        if (typeof req.lyrics !== 'object' || typeof req.lyrics.content !== 'string' || typeof req.lyrics.format !== 'string') {
            return fail('INVALID_REQUEST');
        }
        if (!LYRICS_FORMATS.has(req.lyrics.format) || req.lyrics.content.length > 2_000_000) return fail('INVALID_REQUEST');
    }
    if (req.keySemitones !== undefined && req.keySemitones !== null) {
        const key = req.keySemitones;
        if (typeof key !== 'number' || !Number.isInteger(key) || key < -12 || key > 12) return fail('INVALID_REQUEST');
    }
    if (req.mode !== undefined && !MODES.has(req.mode)) return fail('INVALID_REQUEST');
    if (req.separator !== undefined && !SEPARATORS.has(req.separator)) return fail('INVALID_REQUEST');
    if (!workBaseName(req.artist ?? null, req.title)) return fail('INVALID_REQUEST');
    if (isEncryptedAudio(req.source.fileName)) return fail('SOURCE_ENCRYPTED');
    if (!isOrdinaryAudio(req.source.fileName)) return fail('SOURCE_UNREADABLE');
    return null;
}

function buildConfig(job, model) {
    return {
        schema_version: 2,
        input_files: [job.inputPath],
        output_dir: job.outDir,
        device: 'cuda',
        separate: { mode: job.mode, separator: job.separator },
        convert: {
            model_path: model.path,
            model_sha256: model.sha256,
            index_path: model.indexPath,
            key: job.key,
            f0_method: 'rmvpe',
            rvc: { index_rate: 0.72, rms_mix_rate: 0.5, protect: 0.28, filter_radius: 4 },
            deep: null,
        },
        finalize: {
            work_dir: job.workDir,
            title: job.title,
            artist: job.artist,
            lyrics_path: job.lyricsPath,
            source_song_id: job.sourceSongId,
            model_id: job.modelId,
        },
    };
}

function createCoverJobs(deps, options = {}) {
    const jobs = new Map();
    const order = [];
    let loop = null;
    let shuttingDown = false;
    let gpuCache = null;
    const runJob = options.runJob || runCoverJob;

    const outputRoot = () => (typeof deps.getOutputRoot === 'function' ? deps.getOutputRoot() : null);
    const backendDir = () => (typeof deps.getBackendDir === 'function' ? deps.getBackendDir() : null);
    const userDataDir = () => (typeof deps.userDataDir === 'string' ? deps.userDataDir : '');

    function send(event) {
        try {
            deps.send('ok-cover:job', event);
        } catch (error) {
            console.warn('[cover] send job event failed', error);
        }
    }

    function emit(job, patch) {
        const event = {
            jobId: job.id,
            phase: patch.phase,
            progress: patch.progress,
            indeterminate: patch.indeterminate === true,
            title: job.title,
        };
        if (patch.message) event.message = patch.message;
        if (patch.separator) event.separator = patch.separator;
        if (patch.workId) event.workId = patch.workId;
        if (patch.errorCode) event.errorCode = patch.errorCode;
        job.phase = event.phase;
        job.progress = event.progress;
        job.latest = event;
        send(event);
        return event;
    }

    function note(job, line) {
        if (job.settled) return;
        const mapped = progressFromLine(line);
        if (!mapped) return;
        const nextRank = PHASE_RANK[mapped.phase] ?? 0;
        const currentRank = PHASE_RANK[job.phase] ?? 0;
        if (nextRank < currentRank) return;
        const progress = Math.max(job.progress, mapped.progress);
        const patch = {
            phase: mapped.phase,
            progress,
            indeterminate: mapped.indeterminate,
        };
        if (mapped.message) patch.message = mapped.message;
        if (nextRank >= PHASE_RANK.separating && mapped.separator) patch.separator = mapped.separator;
        const prev = job.latest;
        if (prev
            && prev.phase === patch.phase
            && prev.progress === patch.progress
            && prev.indeterminate === patch.indeterminate
            && prev.message === patch.message
            && prev.separator === patch.separator) {
            return;
        }
        emit(job, patch);
    }

    async function insideOutput(root, target) {
        const rootReal = await fsp.realpath(root);
        let real = target;
        try {
            real = await fsp.realpath(target);
        } catch (error) {
            if (error && error.code === 'ENOENT') real = path.resolve(target);
            else throw error;
        }
        const processing = path.join(rootReal, '.processing');
        if (real === processing || real.startsWith(`${processing}${path.sep}`)) return real;
        return null;
    }

    async function removeJobDir(job) {
        if (!job.jobDir) return;
        try {
            const real = await insideOutput(job.outputRoot, job.jobDir);
            if (!real) {
                console.warn('[cover] refuse to delete outside processing', { jobId: job.id });
                return;
            }
            await fsp.rm(job.jobDir, { recursive: true, force: true });
        } catch (error) {
            console.warn('[cover] cleanup processing dir failed', error);
        }
    }

    async function sweep(root) {
        if (!root) return;
        const dir = path.join(root, '.processing');
        let names;
        try {
            names = await fsp.readdir(dir);
        } catch (error) {
            if (error && error.code === 'ENOENT') return;
            console.warn('[cover] read processing dir failed', error);
            return;
        }
        const keep = new Set();
        for (const job of jobs.values()) {
            if (!job.settled) keep.add(job.id);
        }
        for (const name of names) {
            if (keep.has(name)) continue;
            if (!JOB_ID.test(name)) {
                console.warn('[cover] leave unexpected processing entry', { name });
                continue;
            }
            const target = path.join(dir, name);
            const real = await insideOutput(root, target);
            if (!real) {
                console.warn('[cover] skip processing path outside output root', { name });
                continue;
            }
            await fsp.rm(target, { recursive: true, force: true });
            console.info('[cover] removed leftover processing dir', { name });
        }
    }

    async function gpuStatus() {
        if (gpuCache) return gpuCache;
        const check = options.checkGpu || defaultCheckGpu;
        try {
            gpuCache = await check();
        } catch (error) {
            console.warn('[cover] gpu check failed', error);
            gpuCache = { ok: false, name: null, reason: 'no-nvidia' };
        }
        return gpuCache;
    }

    async function readModel(modelId) {
        const dir = path.join(userDataDir(), 'rvc-models', modelId);
        const modelPath = path.join(dir, `${modelId}.pth`);
        try {
            const st = await fsp.stat(modelPath);
            if (!st.isFile()) return null;
        } catch (error) {
            if (error && error.code !== 'ENOENT') console.warn('[cover] model stat failed', error);
            return null;
        }
        const sha256 = await hashFile(modelPath);
        let indexPath = null;
        try {
            const indexStat = await fsp.stat(path.join(dir, `${modelId}.index`));
            if (indexStat.isFile()) indexPath = path.join(dir, `${modelId}.index`);
        } catch (error) {
            if (error && error.code !== 'ENOENT') console.warn('[cover] index stat failed', error);
        }
        return { path: modelPath, sha256, indexPath };
    }

    async function listModels() {
        const dir = path.join(userDataDir(), 'rvc-models');
        let names;
        try {
            names = await fsp.readdir(dir);
        } catch (error) {
            if (error && error.code === 'ENOENT') return ok([]);
            console.warn('[cover] list models failed', error);
            return fail('UNKNOWN');
        }
        const models = [];
        for (const id of names) {
            if (!MODEL_ID.test(id)) continue;
            const model = await readModel(id);
            if (!model) continue;
            let name = id;
            let addedAt = 0;
            try {
                const meta = JSON.parse(await fsp.readFile(path.join(dir, id, 'meta.json'), 'utf8'));
                if (meta && typeof meta.name === 'string' && meta.name.trim()) name = meta.name;
                if (meta && typeof meta.addedAt === 'number' && Number.isFinite(meta.addedAt)) addedAt = meta.addedAt;
            } catch (error) {
                if (error && error.code !== 'ENOENT') console.warn('[cover] model meta unreadable', error);
            }
            if (!addedAt) {
                const st = await fsp.stat(model.path);
                addedAt = st.mtimeMs;
            }
            models.push({ id, name, hasIndex: model.indexPath !== null, addedAt });
        }
        return ok(models);
    }

    async function componentStatus() {
        const gpu = await gpuStatus();
        const backend = backendDir();
        let installed = false;
        if (typeof backend === 'string' && backend.length > 0) {
            try {
                const st = await fsp.stat(backend);
                installed = st.isDirectory();
            } catch (error) {
                if (error && error.code !== 'ENOENT') console.warn('[cover] backend stat failed', error);
            }
        }
        const gpuValue = { ok: gpu.ok === true, name: typeof gpu.name === 'string' ? gpu.name : null };
        if (!gpuValue.ok) gpuValue.reason = gpu.reason === 'driver-too-old' ? 'driver-too-old' : 'no-nvidia';
        return ok({
            state: installed ? 'installed' : 'absent',
            version: null,
            downloadBytes: 0,
            installedBytes: 0,
            installRoot: installed ? path.resolve(backend, '..', '..', '..') : null,
            gpu: gpuValue,
        });
    }

    function markFinished(job) {
        if (job.finishOnce) return;
        job.finishOnce = true;
        job.resolveFinished();
    }

    async function settleCancelled(job) {
        if (job.settled) {
            markFinished(job);
            return;
        }
        job.settled = true;
        await removeJobDir(job);
        emit(job, { phase: 'cancelled', progress: job.progress, indeterminate: false, errorCode: 'JOB_CANCELLED' });
        console.info('[cover] job cancelled', { jobId: job.id });
        markFinished(job);
    }

    async function settleFailed(job, code) {
        if (job.settled) {
            markFinished(job);
            return;
        }
        job.settled = true;
        await removeJobDir(job);
        emit(job, { phase: 'failed', progress: job.progress, indeterminate: false, errorCode: code });
        console.warn('[cover] job failed', { jobId: job.id, errorCode: code });
        markFinished(job);
    }

    async function uniqueDest(root, base) {
        let dest = path.join(root, base);
        let n = 2;
        for (;;) {
            try {
                await fsp.stat(dest);
            } catch (error) {
                if (error && error.code === 'ENOENT') return dest;
                throw error;
            }
            dest = path.join(root, `${base} (${n})`);
            n += 1;
            if (n > 1000) throw Object.assign(new Error('too many name collisions'), { code: 'EEXIST' });
        }
    }

    async function publish(job, outcome) {
        const workDir = outcome.work_dir;
        if (typeof workDir !== 'string' || workDir.length === 0) {
            await settleFailed(job, 'JOB_FAILED');
            return;
        }
        let workReal;
        try {
            const jobReal = await fsp.realpath(job.jobDir);
            workReal = await fsp.realpath(workDir);
            if (workReal !== jobReal && !workReal.startsWith(`${jobReal}${path.sep}`)) {
                console.warn('[cover] work dir escaped the job dir', { jobId: job.id });
                await settleFailed(job, 'JOB_FAILED');
                return;
            }
        } catch (error) {
            console.warn('[cover] work dir missing', error);
            await settleFailed(job, 'JOB_FAILED');
            return;
        }
        let dest;
        try {
            dest = await uniqueDest(job.outputRoot, job.baseName);
            await fsp.rename(workReal, dest);
        } catch (error) {
            console.warn('[cover] move work failed', error);
            await settleFailed(job, error && error.code === 'ENOSPC' ? 'DISK_FULL' : 'JOB_FAILED');
            return;
        }
        const separator = outcome.separator === 'builtin' || outcome.separator === 'msst-native' ? outcome.separator : undefined;
        if (job.progress < 0.99) {
            emit(job, { phase: 'ingesting', progress: 0.99, indeterminate: false, separator });
        }
        const relPath = path.basename(dest);
        const workId = coverWorkId(relPath);
        try {
            await deps.works.rescan();
        } catch (error) {
            console.warn('[cover] rescan failed', error);
        }
        try {
            deps.works.notifyChanged([workId]);
        } catch (error) {
            console.warn('[cover] notifyChanged failed', error);
        }
        await removeJobDir(job);
        emit(job, { phase: 'done', progress: 1, indeterminate: false, workId, separator });
        job.settled = true;
        console.info('[cover] job done', { jobId: job.id, workId, relPath });
        markFinished(job);
    }

    async function runOne(job) {
        job.starting = true;
        if (job.cancelRequested || job.settled) {
            await settleCancelled(job);
            return;
        }
        const runner = runJob({
            jobId: job.id,
            jobDir: job.jobDir,
            backendDir: job.backendDir,
        }, (line) => note(job, line), {
            commandFor: options.commandFor,
            graceMs: options.graceMs,
            platform: options.platform,
            env: options.env,
        });
        job.runner = runner;
        if (job.cancelRequested) await runner.cancel();
        const outcome = await runner.done;
        if (job.settled) return;
        if (job.cancelRequested || outcome.error_code === 'CANCELLED') {
            await settleCancelled(job);
            return;
        }
        if (outcome.status === 'success') {
            await publish(job, outcome);
            return;
        }
        await settleFailed(job, mapOkcError(outcome.error_code));
    }

    function takeNext() {
        for (const id of order) {
            const job = jobs.get(id);
            if (!job || job.settled || job.cancelRequested) continue;
            if (job.phase === 'queued') return job;
        }
        return null;
    }

    function kick() {
        if (loop) return;
        loop = (async () => {
            try {
                while (!shuttingDown) {
                    const job = takeNext();
                    if (!job) return;
                    try {
                        await runOne(job);
                    } catch (error) {
                        console.warn('[cover] job loop failed', error);
                        await settleFailed(job, 'JOB_FAILED');
                    }
                }
            } finally {
                loop = null;
                if (!shuttingDown && takeNext()) kick();
            }
        })();
    }

    async function submit(req) {
        if (shuttingDown) return fail('JOB_CANCELLED');
        const invalid = validateRequest(req);
        if (invalid) return invalid;
        const root = outputRoot();
        if (!root) return fail('OUTPUT_ROOT_MISSING');
        const backend = backendDir();
        if (!backend) return fail('COMPONENT_MISSING');
        try {
            const st = await fsp.stat(backend);
            if (!st.isDirectory()) return fail('COMPONENT_MISSING');
        } catch (error) {
            if (error && error.code !== 'ENOENT') console.warn('[cover] component stat failed', error);
            return fail('COMPONENT_MISSING');
        }
        const gpu = await gpuStatus();
        if (!gpu.ok) return fail('GPU_UNSUPPORTED');
        if (req.mode === 'aggressive' || req.separator === 'msst-native') return fail('MODE_UNAVAILABLE');
        const model = await readModel(req.modelId);
        if (!model) return fail('MODEL_INVALID');

        const bytes = copyBytes(req.source.bytes);
        const ext = audioExt(req.source.fileName);
        const id = crypto.randomUUID();
        const baseName = workBaseName(req.artist ?? null, req.title);
        const jobDir = path.join(root, '.processing', id);
        const lyrics = req.lyrics && typeof req.lyrics === 'object' ? req.lyrics : null;
        const job = {
            id,
            title: req.title.trim(),
            artist: typeof req.artist === 'string' && req.artist.trim() ? req.artist.trim() : null,
            sourceSongId: req.sourceSongId,
            modelId: req.modelId,
            key: req.keySemitones === undefined || req.keySemitones === null ? 0 : req.keySemitones,
            mode: req.mode || 'library',
            separator: req.separator || 'builtin',
            baseName,
            outputRoot: root,
            backendDir: backend,
            jobDir,
            inDir: path.join(jobDir, 'in'),
            outDir: path.join(jobDir, 'out'),
            inputPath: path.join(jobDir, 'in', `okc_${id.slice(0, 8)}${ext}`),
            workDir: path.join(jobDir, 'work', baseName),
            lyricsPath: lyrics ? path.join(jobDir, 'in', `lyrics.${lyrics.format === 'lrc' ? 'lrc' : 'txt'}`) : null,
            lyrics,
            phase: 'queued',
            progress: 0,
            settled: false,
            cancelRequested: false,
            starting: false,
            runner: null,
            latest: null,
            resolveFinished: () => {},
            finished: Promise.resolve(),
        };
        job.finished = new Promise(resolve => {
            job.resolveFinished = resolve;
        });
        try {
            await sweep(root);
            await fsp.mkdir(job.inDir, { recursive: true });
            await fsp.mkdir(job.outDir, { recursive: true });
            await fsp.mkdir(path.dirname(job.workDir), { recursive: true });
            await fsp.writeFile(job.inputPath, bytes);
            if (job.lyricsPath) await fsp.writeFile(job.lyricsPath, job.lyrics.content);
            const config = buildConfig(job, model);
            await fsp.writeFile(path.join(job.jobDir, 'okc_config.json'), `${JSON.stringify(config, null, 2)}\n`);
        } catch (error) {
            console.warn('[cover] prepare job failed', error);
            await removeJobDir(job);
            return fail(error && error.code === 'ENOSPC' ? 'DISK_FULL' : 'JOB_FAILED');
        }
        jobs.set(job.id, job);
        order.push(job.id);
        emit(job, { phase: 'queued', progress: 0, indeterminate: false });
        console.info('[cover] job queued', { jobId: job.id, mode: job.mode, separator: job.separator });
        kick();
        return ok({ jobId: job.id });
    }

    async function cancel(jobId) {
        if (typeof jobId !== 'string' || !jobs.has(jobId)) return fail('JOB_NOT_FOUND');
        const job = jobs.get(jobId);
        if (job.settled) return ok(undefined);
        job.cancelRequested = true;
        if (job.runner) await job.runner.cancel();
        else if (!job.starting) await settleCancelled(job);
        await job.finished;
        return ok(undefined);
    }

    function listJobs() {
        return ok(order.map(id => jobs.get(id)?.latest).filter(Boolean).map(event => ({ ...event })));
    }

    function shutdown() {
        const live = [...jobs.values()].filter(job => !job.settled);
        if (live.length === 0) return null;
        shuttingDown = true;
        console.info('[cover] shutdown, cancelling jobs', { count: live.length });
        return Promise.all(live.map(job => cancel(job.id))).then(() => loop);
    }

    const ready = (async () => {
        try {
            await sweep(outputRoot());
        } catch (error) {
            console.warn('[cover] startup sweep failed', error);
        }
    })();

    return {
        submit,
        cancel,
        listJobs,
        listModels,
        componentStatus,
        shutdown,
        ready,
        coverWorkId,
    };
}

module.exports = {
    createCoverJobs,
    validateRequest,
    workBaseName,
    coverWorkId,
    buildConfig,
    COVER_ROOT_ID,
};
