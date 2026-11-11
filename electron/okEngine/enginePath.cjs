'use strict';

const fs = require('fs');
const path = require('path');

// 找 ok-engine.exe：OK_ENGINE_PATH 优先，其次安装包 resources，再次开发构建 build/ok-engine。

function resolveOkEnginePath({ resourcesPath = process.resourcesPath, appPath } = {}) {
    const override = process.env.OK_ENGINE_PATH;
    if (typeof override === 'string' && override.trim()) {
        return fs.existsSync(override.trim()) ? override.trim() : null;
    }
    if (resourcesPath) {
        const packaged = path.join(resourcesPath, 'ok-engine.exe');
        if (fs.existsSync(packaged)) return packaged;
    }
    if (appPath) {
        const dev = path.join(appPath, 'build', 'ok-engine', 'ok-engine.exe');
        if (fs.existsSync(dev)) return dev;
    }
    return null;
}

module.exports = { resolveOkEnginePath };
