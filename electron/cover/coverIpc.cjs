'use strict';

const { createSenderGuardedHandler } = require('../ipcAccessGuard.cjs');
const { createCoverJobs } = require('./coverJobs.cjs');

// electron/cover/coverIpc.cjs
// ok-cover 的 handler。任务走 coverJobs；v1 不下载组件，音色文件框留给后面的 coverModels。

const COVER_INVOKE_CHANNELS = Object.freeze([
    'ok-cover:get-component',
    'ok-cover:pick-install-dir',
    'ok-cover:install-component',
    'ok-cover:cancel-install',
    'ok-cover:remove-component',
    'ok-cover:list-models',
    'ok-cover:add-model',
    'ok-cover:remove-model',
    'ok-cover:submit',
    'ok-cover:cancel',
    'ok-cover:list-jobs',
]);

function notImplemented() {
    return { ok: false, code: 'UNKNOWN', detail: 'not implemented' };
}

function registerCoverIpc(ipcMain, deps, options = {}) {
    const isTrusted = typeof options.isTrusted === 'function' ? options.isTrusted : () => false;
    const jobs = createCoverJobs(deps, options.jobs || {});
    if (typeof deps.onQuit === 'function') {
        deps.onQuit(() => jobs.shutdown());
    }

    const handlers = {
        'ok-cover:get-component': () => jobs.componentStatus(),
        'ok-cover:pick-install-dir': () => notImplemented(),
        'ok-cover:install-component': () => ({ ok: false, code: 'DOWNLOAD_UNAVAILABLE' }),
        'ok-cover:cancel-install': () => notImplemented(),
        'ok-cover:remove-component': () => notImplemented(),
        'ok-cover:list-models': () => jobs.listModels(),
        'ok-cover:add-model': () => notImplemented(),
        'ok-cover:remove-model': () => notImplemented(),
        'ok-cover:submit': (_event, req) => jobs.submit(req),
        'ok-cover:cancel': (_event, jobId) => jobs.cancel(jobId),
        'ok-cover:list-jobs': () => jobs.listJobs(),
    };

    for (const channel of COVER_INVOKE_CHANNELS) {
        ipcMain.handle(channel, createSenderGuardedHandler({
            channel,
            isTrusted,
            handler: async (event, ...args) => {
                try {
                    return await handlers[channel](event, ...args);
                } catch (error) {
                    console.warn('[cover] handler failed', error);
                    return { ok: false, code: 'UNKNOWN', detail: 'internal' };
                }
            },
        }));
    }

    return { jobs, channels: COVER_INVOKE_CHANNELS };
}

module.exports = { registerCoverIpc, COVER_INVOKE_CHANNELS };
