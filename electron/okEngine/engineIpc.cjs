'use strict';

// ok-engine:* 的 IPC。作品 id 在这里换成路径，渲染进程拿不到磁盘路径。

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAttempt = (value) => Number.isInteger(value) && value >= 0;

function createOkEngineHandlers(session) {
    return {
        'ok-engine:load': (_event, req) => (validateLoad(req) ? session.load(req) : Promise.resolve({ ok: false, code: 'INVALID_REQUEST' })),
        'ok-engine:play': (_event, attempt) => session.play(attempt),
        'ok-engine:pause': (_event, attempt) => session.pause(attempt),
        'ok-engine:stop': (_event, attempt) => session.stop(attempt),
        'ok-engine:seek': (_event, attempt, sec) => session.seek(attempt, sec),
        'ok-engine:set-mix': (_event, attempt, mix) => session.setMix(attempt, mix),
        'ok-engine:set-karaoke': (_event, on) => session.setKaraoke(on),
        'ok-engine:set-harmony': (_event, on) => session.setHarmony(on),
        'ok-engine:set-master': (_event, volume, muted) => session.setMaster(volume, muted),
        'ok-engine:set-loop-one': (_event, on) => session.setLoopOne(on),
        'ok-engine:list-devices': () => session.listDevices(),
        'ok-engine:set-output-device': (_event, id) => session.setOutputDevice(id),
        'ok-engine:get-snapshot': () => session.getSnapshot(),
    };
}

function validateLoad(req) {
    if (!isObject(req) || !isAttempt(req.attempt) || typeof req.workId !== 'string') return false;
    if (!isObject(req.mix) || !isObject(req.master)) return false;
    if (typeof req.master.volume !== 'number' || typeof req.master.muted !== 'boolean') return false;
    return true;
}

module.exports = { createOkEngineHandlers, validateLoad };
