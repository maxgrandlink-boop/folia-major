'use strict';

const { spawn } = require('child_process');

// 拉起 ok-engine.exe，把 stdin/stdout 的 JSON 行收成命令和事件。三次崩溃后熔断。

const EVENT_CHANNELS = Object.freeze({
    state: 'ok-engine:state',
    clock: 'ok-engine:clock',
    ended: 'ok-engine:ended',
    looped: 'ok-engine:looped',
    error: 'ok-engine:error',
    devices: 'ok-engine:devices',
});

const IDLE_STATE = Object.freeze({
    attempt: 0,
    workId: null,
    status: 'idle',
    durationSec: 0,
    route: 'local',
    outputDeviceId: null,
    karaoke: false,
    harmony: false,
    loopOne: false,
});

function createOkEngineSession({
    resolveExe,
    resolveTracks,
    resolveFfmpeg,
    cacheDir,
    send,
    spawnImpl = spawn,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    crashWindowMs = 60000,
    crashLimit = 3,
} = {}) {
    let child = null;
    let buffer = '';
    let nextId = 0;
    let loaded = false;
    let attempt = 0;
    let stopping = false;
    let circuitOpen = false;
    const pending = new Map();
    const crashes = [];

    const emit = (channel, payload) => {
        if (typeof send === 'function') send(channel, payload);
    };

    const fail = (code, detail) => ({ ok: false, code, ...(detail ? { detail } : {}) });

    const noteCrash = () => {
        const at = now();
        crashes.push(at);
        while (crashes.length > 0 && at - crashes[0] > crashWindowMs) crashes.shift();
        if (!circuitOpen && crashes.length >= crashLimit) {
            circuitOpen = true;
            console.warn(`[ok-engine] failed ${crashes.length} times within ${Math.round(crashWindowMs / 1000)} s`);
        }
    };

    const rejectPending = (code) => {
        for (const entry of pending.values()) {
            clearTimer(entry.timer);
            entry.resolve(fail(code));
        }
        pending.clear();
    };

    const onLine = (line) => {
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            console.warn('[ok-engine] bad line', error);
            return;
        }
        if (message && typeof message.id === 'number' && typeof message.ok === 'boolean') {
            const entry = pending.get(message.id);
            if (!entry) return;
            clearTimer(entry.timer);
            pending.delete(message.id);
            entry.resolve(message.ok
                ? { ok: true, value: message.value }
                : fail(message.code || 'UNKNOWN', message.detail));
            return;
        }
        if (!message || typeof message.event !== 'string') return;
        const channel = EVENT_CHANNELS[message.event];
        if (!channel) return;
        const payload = { ...message };
        delete payload.event;
        emit(channel, payload);
    };

    const attach = (proc) => {
        proc.stdout.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let nl = buffer.indexOf('\n');
            while (nl >= 0) {
                const line = buffer.slice(0, nl).replace(/\r$/, '');
                buffer = buffer.slice(nl + 1);
                if (line.trim()) onLine(line);
                nl = buffer.indexOf('\n');
            }
        });
        proc.stderr.on('data', (chunk) => {
            for (const line of chunk.toString('utf8').split(/\n/)) {
                if (line.trim()) console.warn('[ok-engine]', line);
            }
        });
        proc.on('error', (error) => {
            console.warn('[ok-engine] spawn failed', error);
            rejectPending('ENGINE_SPAWN_FAILED');
        });
        proc.on('exit', () => {
            const unexpected = !stopping;
            child = null;
            loaded = false;
            buffer = '';
            rejectPending('ENGINE_CRASHED');
            if (!unexpected) return;
            noteCrash();
            emit('ok-engine:error', { attempt: attempt || null, code: 'ENGINE_CRASHED', fatal: true });
            emit('ok-engine:state', { ...IDLE_STATE, attempt, status: 'error' });
            setTimer(() => emit('ok-engine:state', { ...IDLE_STATE, attempt }), 1000);
        });
    };

    const ensure = () => {
        if (circuitOpen) return fail('CIRCUIT_OPEN');
        if (child) return { ok: true };
        const exe = typeof resolveExe === 'function' ? resolveExe() : null;
        if (!exe) return fail('ENGINE_NOT_FOUND');
        stopping = false;
        try {
            child = spawnImpl(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        } catch (error) {
            console.warn('[ok-engine] spawn failed', error);
            return fail('ENGINE_SPAWN_FAILED');
        }
        if (!child || !child.stdin || !child.stdout) return fail('ENGINE_SPAWN_FAILED');
        attach(child);
        return { ok: true };
    };

    const request = (cmd, args, timeoutMs) => new Promise((resolve) => {
        const started = ensure();
        if (!started.ok) {
            resolve(started);
            return;
        }
        const id = ++nextId;
        const timer = setTimer(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            resolve(fail('IPC_TIMEOUT'));
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });

    const withAttempt = async (value, run) => {
        if (!Number.isInteger(value) || value < 0) return fail('INVALID_REQUEST');
        if (!loaded) return fail('NOT_LOADED');
        if (value !== attempt) return fail('SUPERSEDED');
        const started = ensure();
        if (!started.ok) return started;
        return run();
    };

    return {
        async load(req) {
            if (!req || typeof req !== 'object' || !Number.isInteger(req.attempt)) return fail('INVALID_REQUEST');
            const tracks = typeof resolveTracks === 'function' ? await resolveTracks(req.workId) : null;
            if (!tracks) return fail('WORK_NOT_FOUND');
            const started = ensure();
            if (!started.ok) return started;
            const ffmpeg = typeof resolveFfmpeg === 'function' ? await resolveFfmpeg() : null;
            const result = await request('load', {
                attempt: req.attempt,
                workId: req.workId,
                tracks: {
                    vocal: tracks.vocal || null,
                    instrumental: tracks.instrumental || null,
                    original: tracks.original || null,
                    harmony: tracks.harmony || null,
                },
                mix: req.mix,
                karaoke: req.karaoke === true,
                harmony: req.harmony === true,
                master: req.master,
                startSec: req.startSec,
                autoplay: req.autoplay === true,
                loopOne: req.loopOne === true,
                cacheDir: typeof cacheDir === 'function' ? cacheDir() : '',
                ffmpeg: ffmpeg || '',
            }, 120000);
            if (result.ok) {
                loaded = true;
                attempt = req.attempt;
            }
            return result;
        },
        play: (value) => withAttempt(value, () => request('play', { attempt: value }, 3000)),
        pause: (value) => withAttempt(value, () => request('pause', { attempt: value }, 3000)),
        stop: (value) => withAttempt(value, () => request('stop', { attempt: value }, 3000)),
        seek: (value, sec) => withAttempt(value, () => request('seek', { attempt: value, sec }, 3000)),
        setMix: (value, mix) => withAttempt(value, () => request('setMix', { attempt: value, mix }, 3000)),
        setKaraoke: async (on) => (ensure().ok ? request('setKaraoke', { on: on === true }, 3000) : ensure()),
        setHarmony: async (on) => (ensure().ok ? request('setHarmony', { on: on === true }, 3000) : ensure()),
        setMaster: async (volume, muted) => (ensure().ok ? request('setMaster', { volume, muted: muted === true }, 3000) : ensure()),
        setLoopOne: async (on) => (ensure().ok ? request('setLoopOne', { on: on === true }, 3000) : ensure()),
        listDevices: () => request('listDevices', {}, 3000),
        setOutputDevice: (id) => request('setOutputDevice', { id: id == null ? null : id }, 3000),
        async getSnapshot() {
            if (!child && !loaded) return { ok: true, value: null };
            return request('getSnapshot', {}, 3000);
        },
        killSync() {
            stopping = true;
            if (!child) return;
            try {
                child.kill();
            } catch (error) {
                console.warn('[ok-engine] kill failed', error);
            }
        },
    };
}

module.exports = { createOkEngineSession, EVENT_CHANNELS, IDLE_STATE };
