// src/services/multitrack/parseWorkLyrics.ts
// 作品歌词。增强 LRC 的逐字时间 `<mm:ss.xx>` 留在字上，普通 LRC 一行一个时间。

export interface LyricWord {
    text: string;
    timeSec: number;
}

export interface LyricLine {
    timeSec: number;
    text: string;
    words: LyricWord[];
}

const LINE = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/;
const WORD = /<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g;

function stamp(minutes: string, seconds: string): number {
    return Number(minutes) * 60 + Number(seconds);
}

/** 解析作品 LRC。元数据标签丢掉；没有逐字时间的行整行一个时间。 */
export function parseWorkLyrics(content: string): LyricLine[] {
    const lines: LyricLine[] = [];
    for (const raw of content.split(/\r?\n/)) {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('[ti:') || trimmed.startsWith('[ar:') || trimmed.startsWith('[al:') || trimmed.startsWith('[by:') || trimmed.startsWith('[offset:')) {
            continue;
        }
        const match = trimmed.match(LINE);
        if (!match) continue;
        const timeSec = stamp(match[1], match[2]);
        const body = match[3] ?? '';
        const words: LyricWord[] = [];
        WORD.lastIndex = 0;
        let word: RegExpExecArray | null;
        while ((word = WORD.exec(body)) !== null) {
            if (word[3]) words.push({ text: word[3], timeSec: stamp(word[1], word[2]) });
        }
        const text = words.length > 0 ? words.map(item => item.text).join('') : body.trim();
        if (!text) continue;
        lines.push({ timeSec, text, words });
    }
    return lines;
}

/** 当前句和句内当前字。时间还没到第一句时两个都是 -1。 */
export function activeLyricIndex(lines: readonly LyricLine[], positionSec: number): { line: number; word: number } {
    let line = -1;
    for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].timeSec <= positionSec + 1e-3) line = index;
        else break;
    }
    if (line < 0) return { line: -1, word: -1 };
    const words = lines[line].words;
    let word = -1;
    for (let index = 0; index < words.length; index += 1) {
        if (words[index].timeSec <= positionSec + 1e-3) word = index;
        else break;
    }
    return { line, word };
}
