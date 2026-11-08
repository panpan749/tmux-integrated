import * as path from 'path';
import { stat } from 'fs/promises';

/** Resolve paths on the extension host, which is the terminal machine under Remote SSH/WSL. */
export async function resolveTerminalDirectory(input: string, base: string, home = process.env.HOME): Promise<string> {
    if (!input.trim()) { throw new Error('Enter a directory path'); }
    let directory = input;
    if (directory === '~' || directory.startsWith('~/')) {
        if (!home) { throw new Error('Home directory is unavailable; enter an absolute path'); }
        directory = path.join(home, directory.slice(2));
    }
    directory = path.resolve(base, directory);
    let info;
    try { info = await stat(directory); }
    catch { throw new Error(`Directory does not exist or cannot be accessed: ${directory}`); }
    if (!info.isDirectory()) { throw new Error(`Not a directory: ${directory}`); }
    return directory;
}
