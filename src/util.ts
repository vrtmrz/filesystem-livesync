import path from "path";

export function isPlainText(filename: string): boolean {
    if (filename.endsWith(".md")) return true;
    if (filename.endsWith(".txt")) return true;
    if (filename.endsWith(".svg")) return true;
    if (filename.endsWith(".html")) return true;
    if (filename.endsWith(".csv")) return true;
    if (filename.endsWith(".css")) return true;
    if (filename.endsWith(".js")) return true;
    if (filename.endsWith(".xml")) return true;

    return false;
}

export const path2unix = (pathStr: string) => pathStr.split(path.sep).join(path.posix.sep);

let known_files: string[] = [];
let touchedFile: string[] = [];
export function addKnownFile(syncKey: string, id: string, rev: string) {
    known_files.push(`${syncKey}-${id}-${rev}`);
    known_files = known_files.slice(-50);
}
export function isKnownFile(syncKey: string, id: string, rev: string) {
    return known_files.indexOf(`${syncKey}-${id}-${rev}`) !== -1;
}
export function addTouchedFile(pathSrc: string, mtime: number) {
    const rmtime = ~~(mtime / 5000);
    const targetFile = path.resolve(pathSrc);
    const key = `${targetFile}-${rmtime}`;
    touchedFile.push(key);
    touchedFile = touchedFile.slice(-50);
}
export function isTouchedFile(pathSrc: string, mtime: number) {
    const rmtime = ~~(mtime / 5000);
    const targetFile = path.resolve(pathSrc);
    const key = `${targetFile}-${rmtime}`;
    return touchedFile.indexOf(key) !== -1;
}

export const DATEDIFF_NEWER_A = 1;
export const DATEDIFF_OLDER_B = 1;
export const DATEDIFF_EVEN = 0;
export const DATEDIFF_OLDER_A = -1;
export const DATEDIFF_NEWER_B = -1;
export type DATEDIFF = 1 | 0 | -1;
export function calcDateDiff(a: number | Date, b: number | Date, resolution = 1000): DATEDIFF {
    const da = ~~((typeof a == "number" ? a : a.getTime()) / resolution);
    const db = ~~((typeof b == "number" ? b : b.getTime()) / resolution);
    if (da == db) return DATEDIFF_EVEN;
    const diff = (da - db) / Math.abs(da - db);
    return diff as DATEDIFF;
}
