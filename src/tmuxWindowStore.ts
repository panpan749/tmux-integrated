import { randomUUID } from 'crypto';
import * as path from 'path';
import { execFile } from 'child_process';
import { TmuxControlClient, shellescape } from './tmuxControlClient';

const MANAGED_SESSION_OPTION = '@tmux-integrated-managed';
export const SESSION_KEY_OPTION = '@tmux-integrated-session-key';

export interface ManagedSession {
    sessionId: string;
    sessionName: string;
    directory: string;
    windows: ManagedWindow[];
}

export function validateSessionName(name: string): string | undefined {
    if (!name.trim()) { return 'Session name cannot be empty'; }
    if (/[.:\x00-\x1f\x7f]/.test(name)) { return 'Session names cannot contain periods, colons or control characters'; }
    return undefined;
}

export const DIRECTORY_OPTION = '@tmux-integrated-directory';

export interface ManagedWindow {
    sessionId: string;
    sessionName: string;
    windowId: string;
    paneId: string;
    windowIndex: number;
    directory: string;
    name: string;
    automaticRename: boolean;
    managed: boolean;
    active: boolean;
}

/** tmux owns this metadata, so it survives editor reloads and is shared by clients. */
export async function markManagedWindow(
    client: TmuxControlClient, windowId: string, directory: string, adopted = false,
): Promise<void> {
    await client.sendCommand(`set-option ${MANAGED_SESSION_OPTION} 1`);
    const current = await client.sendCommand(`show-options -w -v -t ${windowId} ${DIRECTORY_OPTION}`).catch(() => []);
    if (current[0]) { return; }
    // Older windows have no marker: use their current pane directory when adopting.
    if (adopted) {
        const paneDirectory = await client.sendCommand(`display-message -t ${windowId} -p '#{pane_current_path}'`).catch(() => []);
        directory = paneDirectory[0] || directory;
    }
    const encoded = Buffer.from(directory, 'utf8').toString('base64');
    await client.sendCommand(`set-option -w -t ${windowId} ${DIRECTORY_OPTION} ${shellescape(encoded)}`);
}

export class TmuxWindowStore {
    constructor(private readonly binary: () => string = () => 'tmux') {}

    run(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(this.binary(), args, { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr.trim() || error.message));
                } else {
                    resolve(stdout);
                }
            });
        });
    }

    async list(): Promise<ManagedWindow[]> {
        let output: string;
        try {
            output = await this.run(['list-windows', '-a', '-F',
                `#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}\t#{window_index}\t#{automatic-rename}\t#{${DIRECTORY_OPTION}}\t#{${SESSION_KEY_OPTION}}\t#{${MANAGED_SESSION_OPTION}}\t#{pane_current_path}\t#{window_active}\t#{session_path}\t#{window_name}`]);
        } catch (error) {
            if (/no server running|no sessions|error connecting to .*No such file or directory/.test(String(error))) { return []; }
            throw error;
        }
        const rows = output.trimEnd().split('\n').map(line => line.split('\t'));
        const managedSessions = new Set(rows.filter(row => row[6] || row[7] || row[8] === '1').map(row => row[0]));
        return rows.flatMap(row => {
            const [sessionId, sessionName, windowId, paneId, index, automatic, encoded, , , paneDirectory, active, sessionDirectory, ...name] = row;
            if (!/^@[0-9]+$/.test(windowId) || !/^\$[0-9]+$/.test(sessionId)) { return []; }
            const directory = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : (paneDirectory || sessionDirectory);
            if (!directory) { return []; }
            return [{ sessionId, sessionName, windowId, paneId, windowIndex: Number(index),
                automaticRename: automatic === '1', directory, name: name.join('\t'),
                managed: managedSessions.has(sessionId), active: active === '1' }];
        }).sort((a, b) => Number(b.active) - Number(a.active));
    }

    async create(directory: string, prefix?: string, shell?: string): Promise<ManagedWindow> {
        const base = (prefix || path.basename(directory) || 'terminal').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^-+/, '') || 'terminal';
        const name = `${base}-${randomUUID().slice(0, 8)}`;
        const args = ['new-session', '-d', '-s', name, '-n', name, '-c', directory, '-P', '-F', '#{session_id}'];
        if (shell) { args.push(`${shellescape(shell)} -l`); }
        const id = (await this.run(args)).trim();
        try {
            await this.run(['set-option', '-t', id, MANAGED_SESSION_OPTION, '1']);
            await this.run(['set-option', '-w', '-t', `${id}:`, DIRECTORY_OPTION, Buffer.from(directory).toString('base64')]);
            const window = (await this.list()).find(w => w.sessionId === id);
            if (!window) { throw new Error('Created session has no window'); }
            return window;
        } catch (error) {
            await this.run(['kill-session', '-t', id]).catch(() => {});
            throw error;
        }
    }

    async find(window: ManagedWindow): Promise<ManagedWindow> {
        const current = (await this.list()).find(w => w.windowId === window.windowId && w.sessionId === window.sessionId);
        if (!current) { throw new Error('This tmux window no longer exists. Refresh the terminal list.'); }
        return current;
    }

    async findSession(session: ManagedSession): Promise<ManagedSession> {
        const windows = (await this.list()).filter(w => w.sessionId === session.sessionId);
        if (!windows.length) { throw new Error('This tmux session no longer exists. Refresh the terminal list.'); }
        return { ...session, sessionName: windows[0].sessionName, windows };
    }

    async renameSession(session: ManagedSession, name: string): Promise<void> {
        const error = validateSessionName(name);
        if (error) { throw new Error(error); }
        await this.findSession(session);
        await this.run(['rename-session', '-t', session.sessionId, '--', name]);
    }

    async deleteSession(session: ManagedSession): Promise<void> {
        await this.findSession(session);
        // detach-on-destroy=off normally switches attached clients into another
        // session. Explicitly detach these clients so deletion exits their tmux UI.
        await this.run(['detach-client', '-s', session.sessionId]);
        await this.run(['kill-session', '-t', session.sessionId]);
    }

    async rename(window: ManagedWindow, name: string): Promise<void> {
        await this.find(window);
        await this.run(['set-option', '-w', '-t', window.windowId, 'automatic-rename', 'off']);
        await this.run(['rename-window', '-t', window.windowId, name]);
    }

    async delete(window: ManagedWindow): Promise<void> {
        await this.find(window);
        await this.run(['set-option', '-t', window.sessionId, MANAGED_SESSION_OPTION, '1']);
        await this.run(['kill-window', '-t', window.windowId]);
    }
}
