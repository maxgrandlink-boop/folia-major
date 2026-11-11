'use strict';

// electron/cover/coverHost.cjs
// B1 还没交出 CoverDeps 时的桩：输出根和组件目录先空着，事件发给现有窗口，退出时转给 coverJobs。

function createUnavailableCoverDeps() {
    return {
        userDataDir: '',
        getOutputRoot() {
            return null;
        },
        getBackendDir() {
            return null;
        },
        works: {
            async rescan() {},
            notifyChanged() {},
        },
        send() {},
        onQuit() {},
    };
}

function createCoverHost({ getUserDataDir, getMainWindow, getWindows, getOutputRoot, getBackendDir }) {
    let onQuit = null;
    const deps = {
        get userDataDir() {
            return getUserDataDir();
        },
        getOutputRoot() {
            return typeof getOutputRoot === 'function' ? getOutputRoot() : null;
        },
        getBackendDir() {
            return typeof getBackendDir === 'function' ? getBackendDir() : null;
        },
        works: {
            async rescan() {},
            notifyChanged() {},
        },
        send(channel, payload) {
            const windows = typeof getWindows === 'function'
                ? getWindows()
                : [typeof getMainWindow === 'function' ? getMainWindow() : null].filter(Boolean);
            for (const win of windows) {
                if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) continue;
                try {
                    win.webContents.send(channel, payload);
                } catch (error) {
                    console.warn('[cover] send failed', error);
                }
            }
        },
        onQuit(cb) {
            onQuit = cb;
        },
    };
    return {
        deps,
        shutdown() {
            if (typeof onQuit !== 'function') return null;
            try {
                const result = onQuit();
                return result && typeof result.then === 'function' ? result : null;
            } catch (error) {
                console.warn('[cover] shutdown failed', error);
                return null;
            }
        },
    };
}

module.exports = { createCoverHost, createUnavailableCoverDeps };
