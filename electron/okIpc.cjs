'use strict';

const { createSenderGuardedHandler } = require('./ipcAccessGuard.cjs');
const { registerCoverIpc } = require('./cover/coverIpc.cjs');
const { createUnavailableCoverDeps } = require('./cover/coverHost.cjs');

// electron/okIpc.cjs
// ok-* 的 invoke 通道都登记上。翻唱交给 coverIpc；其余在对应模块接上之前仍回 not implemented。

const OK_INVOKE_CHANNELS = Object.freeze([
    'ok-works:list-roots',
    'ok-works:add-root',
    'ok-works:remove-root',
    'ok-works:rescan',
    'ok-works:list',
    'ok-works:read-settings',
    'ok-works:write-settings',
    'ok-works:read-cover',
    'ok-works:reveal',
    'ok-engine:load',
    'ok-engine:play',
    'ok-engine:pause',
    'ok-engine:stop',
    'ok-engine:seek',
    'ok-engine:set-mix',
    'ok-engine:set-karaoke',
    'ok-engine:set-harmony',
    'ok-engine:set-master',
    'ok-engine:set-loop-one',
    'ok-engine:list-devices',
    'ok-engine:set-output-device',
    'ok-engine:get-snapshot',
    'ok-live:get-status',
    'ok-live:set-mode',
    'ok-live:set-follow-config',
    'ok-live:set-smart-reverb',
    'ok-live:set-plugin-gains',
    'ok-live:set-leave-ai-gap',
    'ok-live:set-levels-subscribed',
    'ok-live:get-plugin-info',
    'ok-live:open-plugin-folder',
    'ok-cover:get-component',
    'ok-cover:pick-install-dir',
    'ok-cover:install-component',
    'ok-cover:locate-component',
    'ok-cover:cancel-install',
    'ok-cover:remove-component',
    'ok-cover:list-models',
    'ok-cover:add-model',
    'ok-cover:remove-model',
    'ok-cover:submit',
    'ok-cover:cancel',
    'ok-cover:list-jobs',
]);

const notImplemented = () => ({ ok: false, code: 'UNKNOWN', detail: 'not implemented' });

function registerOkIpc({ ipcMain, isTrustedSender, coverDeps, coverOptions }) {
    for (const channel of OK_INVOKE_CHANNELS) {
        if (channel.startsWith('ok-cover:')) continue;
        ipcMain.handle(channel, createSenderGuardedHandler({
            channel,
            isTrusted: isTrustedSender,
            handler: notImplemented,
        }));
    }
    const cover = registerCoverIpc(ipcMain, coverDeps || createUnavailableCoverDeps(), {
        isTrusted: isTrustedSender,
        jobs: coverOptions,
    });
    return { channels: OK_INVOKE_CHANNELS, cover };
}

module.exports = { registerOkIpc, OK_INVOKE_CHANNELS };
