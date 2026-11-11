// src/services/multitrack/format.ts
// 作品字节和播放时间的界面格式。字节按 1024³ 显示成 GB。

const GIBIBYTE = 1024 ** 3;

/** 整数字节 → “x.xx GB”。不足 0.01 GB 仍保留两位，不改用 MB。 */
export function formatGigabytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '0.00 GB';
    return `${(bytes / GIBIBYTE).toFixed(2)} GB`;
}

export function formatClock(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const whole = Math.floor(sec);
    const minutes = Math.floor(whole / 60);
    const seconds = whole % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
