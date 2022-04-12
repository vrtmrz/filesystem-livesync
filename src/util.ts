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
    const targetFile = path.resolve(pathSrc);
    const key = `${targetFile}-${~~(mtime / 10)}`;
    touchedFile.push(key);
    touchedFile = touchedFile.slice(-50);
}
export function isTouchedFile(pathSrc: string, mtime: number) {
    const targetFile = path.resolve(pathSrc);
    const key = `${targetFile}-${~~(mtime / 10)}`;
    return touchedFile.indexOf(key) !== -1;
}
