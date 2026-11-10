import type { WorksRoot, Work, WorkSkip, OutputDevice } from '../../types/multitrack';
import type { RvcModel } from '../../types/cover';

// src/services/okMock/fixtures.ts —— 内置示例数据（歌名、歌词都是虚构的）。数据与 W1 契约第 6 节的夹具一致。

export const MOCK_ROOT: WorksRoot = { id: 'root-demo', displayPath: 'E:\\Doubao-Lite-Customer-Test\\_internal\\豆苞数据', kind: 'collection-root', addedAt: 1793808000000, available: true, isCoverOutput: false };
export const MOCK_COVER_ROOT: WorksRoot = { id: 'root-cover', displayPath: 'C:\\Users\\demo\\Music\\ok唱歌作品', kind: 'works-dir', addedAt: 1793808000000, available: true, isCoverOutput: true };

const t = (role: Work['tracks'][number]['role'], fileName: string, durationSec: number): Work['tracks'][number] =>
    ({ role, source: 'name-rule', fileName, sizeBytes: Math.round(durationSec * 176400), mtimeMs: 1793298369000, durationSec });

// 「白允y - 暗号」照真实样本的结构（/workspace/doubao/materials/works/白允y - 暗号：_listing.txt、manifest.json、cs.json、_volume.json）；
// 歌词只保留真实的标签和时间戳格式（增强 LRC，逐字 <mm:ss.xx>），字换成占位。其余三首是虚构的边界用例。
export const MOCK_WORKS: Work[] = [
    {
        id: 'w-anhao', rootId: 'root-demo', relPath: '白允y - 暗号', baseName: '白允y - 暗号',
        title: '暗号', artist: '白允y',
        tracks: [
            { role: 'vocal', source: 'manifest', fileName: '白允y - 暗号人声.wav', sizeBytes: 47492912, mtimeMs: 1793384769000, durationSec: 269.23394557823127 },
            { role: 'instrumental', source: 'manifest', fileName: '白允y - 暗号伴奏.wav', sizeBytes: 47492912, mtimeMs: 1793384769000, durationSec: 269.23394557823127 },
            { role: 'original', source: 'manifest', fileName: '白允y - 暗号原声.wav', sizeBytes: 47492912, mtimeMs: 1793384769000, durationSec: 269.23394557823127 },
        ],
        lyrics: { fileName: 'lyrics.lrc', format: 'lrc', content: '[ti:暗号]\n[ar:白允y]\n[offset:0]\n[00:16.02]<00:16.02>占<00:16.23>位<00:16.50>一\n[00:19.89]<00:19.89>占<00:19.98>位<00:20.52>二\n[00:24.09]<00:24.09>占<00:24.39>位<00:24.63>三\n[00:30.21]<00:30.21>占<00:30.24>位<00:30.60>四' },
        hasCover: true, completedAtMs: 1793384770416, signature: 'sig-anhao',
        meta: { songId: '20261031_022609_757', createdAt: '2026-10-31 02:26:09.757', sampleRate: 44100, channels: 2 },
        warnings: [],
    },
    {
        id: 'w-yehang', rootId: 'root-demo', relPath: '自建歌单/练习/示例歌手B - 夜航', baseName: '示例歌手B - 夜航',
        title: '夜航', artist: '示例歌手B',
        tracks: [t('vocal', '示例歌手B - 夜航人声.wav', 190.0), t('instrumental', '示例歌手B - 夜航伴奏.wav', 198.2), t('original', '示例歌手B - 夜航原声.wav', 198.2), t('harmony', '示例歌手B - 夜航和声.wav', 198.2)],
        lyrics: { fileName: '夜航.lrc', format: 'lrc', content: '[00:12.00]夜航第一句\n[00:20.50]夜航第二句' },
        hasCover: false, completedAtMs: 1793381170416, signature: 'sig-yehang', meta: null, warnings: [],
    },   // 虚构：带和声、人声比伴奏短 8.2 s（测补静音和按时间轴轨＝伴奏结束；和声默认关）
    {
        id: 'w-lianxi', rootId: 'root-demo', relPath: '清唱练习', baseName: '清唱练习',
        title: '清唱练习', artist: null,
        tracks: [t('vocal', '清唱练习人声.wav', 95.0), t('instrumental', '清唱练习伴奏.wav', 95.0)],
        lyrics: null, hasCover: false, completedAtMs: 1793377570416, signature: 'sig-lianxi', meta: null, warnings: [],
    },   // 虚构：没有原唱、没有歌词
    {
        id: 'w-broken', rootId: 'root-demo', relPath: '损坏作品', baseName: '损坏作品',
        title: '损坏作品', artist: null,
        tracks: [t('vocal', '损坏作品人声.wav', 60.0)],
        lyrics: null, hasCover: false, completedAtMs: 1793373970416, signature: 'sig-broken', meta: null, warnings: [],
    },   // 虚构：engine.load 固定回 TRACK_UNREADABLE
];

/** 智能混响用：各作品人声轨的空白段（秒）。暗号的第一段取自真实歌词第一句时间 00:16.02，其余为示例。 */
export const MOCK_SILENT_RANGES: Record<string, Array<[number, number]>> = {
    'w-anhao': [[0, 16.02], [120.5, 131.0]],
    'w-yehang': [[0, 12.0], [90.0, 101.5], [190.0, 198.2]],
    'w-lianxi': [[0, 3.0]],
};

// 「周杰伦 - 稻香」照真实样本：文件夹里只有 _volume.json（见其 _listing.txt），没有任何轨 → no-tracks
export const MOCK_SKIPPED: WorkSkip[] = [{ relPath: '周杰伦 - 稻香', reason: 'no-tracks' }, { relPath: '残缺作品', reason: 'not-complete' }];
export const MOCK_MODELS: RvcModel[] = [{ id: 'm-demo', name: '示例音色', hasIndex: true, addedAt: 1793808000000 }];
export const MOCK_DEVICES: OutputDevice[] = [
    { id: 'dev-speakers', name: '扬声器（示例）', isDefault: true },
    { id: 'dev-headset', name: '耳机（示例）', isDefault: false },
];
