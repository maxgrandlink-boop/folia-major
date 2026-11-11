'use strict';

// W2 登记作品路径。没登记时 load 回 WORK_NOT_FOUND，引擎不猜磁盘布局。

let resolver = async () => null;

function setWorkTrackResolver(fn) {
    resolver = typeof fn === 'function' ? fn : async () => null;
}

async function resolveWorkTracks(workId) {
    if (typeof workId !== 'string' || workId.length === 0) return null;
    const tracks = await resolver(workId);
    if (!tracks || typeof tracks !== 'object') return null;
    return tracks;
}

module.exports = { setWorkTrackResolver, resolveWorkTracks };
