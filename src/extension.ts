/**
 * Extension entry point for tmux-integrated.
 *
 * On activation the extension:
 *   1. Verifies that tmux ≥ 2.0 is installed.
 *   2. Connects each terminal to its own tmux session using control mode (-CC).
 *   3. Updates the session environment with the current VS Code IPC variables
 *      so that `code <file>` works in new tmux windows.
 *   4. Registers a "tmux" terminal profile and two commands.
 *
 * Each VS Code terminal tab maps 1:1 to a tmux window (like iTerm2's tmux
 * integration). Closing a tab preserves its window by default.  When VS Code
 * exits, the session persists so windows can be re-adopted on next launch.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { TmuxControlClient } from './tmuxControlClient';
import { TmuxTerminal } from './tmuxTerminalProvider';
import { ManagedSession, ManagedWindow, TmuxWindowStore, validateSessionName } from './tmuxWindowStore';
import { TmuxTreeProvider } from './tmuxTreeProvider';
import { resolveTerminalDirectory } from './terminalDirectory';

let treeProvider: TmuxTreeProvider | undefined;
const sidebarClients = new Map<string, Promise<TmuxControlClient>>();
const sidebarTerminals = new Map<string, vscode.Terminal>();
const windowStore = new TmuxWindowStore();
let statusBar: vscode.StatusBarItem | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let extensionRootPath = process.cwd();
let globalStoragePath: string | undefined;
let defaultStartDirectory = process.cwd();
let disposing = false;
let restoreQueue: Promise<ManagedWindow[]> | undefined;
let autoRestoreTimer: ReturnType<typeof setTimeout> | undefined;
const attachedWindowIds = new Set<string>();
const terminalPtyByTerminal = new Map<vscode.Terminal, TmuxTerminal>();
const pendingTerminalPtys: TmuxTerminal[] = [];
const reservedWindowByPty = new WeakMap<TmuxTerminal, string>();
const sessionIdByPty = new WeakMap<TmuxTerminal, string>();
let activeTmuxWindowId: string | null = null;
let pendingUserTerminalFocus: boolean = false;

// ---------------------------------------------------------------------------
// Activation / deactivation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel('tmux-integrated');
    context.subscriptions.push(outputChannel);

    extensionRootPath = context.extensionPath;
    globalStoragePath = context.globalStorageUri.fsPath;
    defaultStartDirectory = resolveStartDirectory(context.extensionPath);
    disposing = false;
    restoreQueue = undefined;

    log(`Activating: extensionPath=${extensionRootPath}, appRoot=${vscode.env.appRoot}, startDir=${defaultStartDirectory}`);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'tmux-integrated.attachWindow';
    statusBar.show();
    context.subscriptions.push(statusBar);
    setStatus('$(terminal) tmux-integrated: idle', 'Connects when you open or attach a tmux terminal');

    registerTerminalRenameSync(context);
    registerTerminalProfile(context);
    registerCommands(context);
    registerSidebar(context);

    // --- Clean up when the extension host shuts down ----------------------
    // Disconnect control clients on shutdown; the tmux sessions themselves survive.
    // `disposing` is only a secondary guard on the kill path: a remote host may
    // drop the workbench connection without ever deactivating us, so
    // TmuxTerminal decides a window's fate from the terminal's exit reason
    // rather than from whether this ran in time.
    context.subscriptions.push({
        dispose: () => {
            disposing = true;
            terminalPtyByTerminal.clear();
            pendingTerminalPtys.length = 0;
            activeTmuxWindowId = null;
            if (autoRestoreTimer) { clearTimeout(autoRestoreTimer); }
            for (const connection of sidebarClients.values()) {
                void connection.then(c => c.disconnect(), () => {});
            }
            sidebarClients.clear();
            sidebarTerminals.clear();

        },
    });

    // The workbench can spawn an OS-default shell terminal (`/bin/zsh -il`
    // on macOS, etc.) before any extension is activated, even when
    // `terminal.integrated.defaultProfile.<os>` resolves to a
    // contributed profile like `tmux-integrated`. The window between
    // workbench-launch and our `registerTerminalProfileProvider` call
    // is wider on Cursor than on stock VS Code but exists on both —
    // see upstream microsoft/vscode#123188 / #263504. There is no
    // activation event that fires *before* the workbench starts
    // populating the terminal panel, so the only remedy from inside
    // an extension is to detect and dispose the stray.
    //
    // Gated on:
    //   - `tmux-integrated.closeStrayShellsOnActivation` (default true)
    //   - `terminal.integrated.defaultProfile.<os>` === `tmux-integrated`
    //     (so users who deliberately mix profiles are never affected)
    //
    // Any tab that does not look like one of ours (`tmux` or `tmux:N`)
    // is treated as a stray when both gates are satisfied. Restored
    // tmux-backed tabs go through `provideTerminalProfile` and acquire
    // a TmuxTerminal pty, so they are never disposed here.
    const stray = vscode.window.terminals.filter(
        (t) => !looksLikeTmuxTerminal(t) && !getTmuxPtyFromTerminal(t),
    );
    if (stray.length > 0) {
        const cfgRoot = vscode.workspace.getConfiguration('tmux-integrated');
        const closeStray = cfgRoot.get<boolean>('closeStrayShellsOnActivation', true);
        const names = stray.map((t) => t.name).join(', ');
        if (closeStray && isTmuxIntegratedDefaultProfile()) {
            log(`Disposing ${stray.length} stray non-tmux terminal(s) at activation: [${names}] ` +
                `(defaultProfile.<os>=tmux-integrated, closeStrayShellsOnActivation=true). ` +
                `See README "Stray default-shell tab on launch" for context.`);
            for (const t of stray) {
                try { t.dispose(); } catch (err) { log(`stray dispose warning: ${err}`); }
            }
        } else {
            log(`Non-tmux terminals already present at activation: [${names}]. ` +
                `Auto-close skipped (closeStrayShellsOnActivation=${closeStray}, ` +
                `defaultProfile.<os>=${currentPlatformDefaultProfile() ?? '<unset>'}). ` +
                `See README "Stray default-shell tab on launch" for context.`);
        }
    }

    if (vscode.workspace.getConfiguration('tmux-integrated').get<boolean>('autoConnect', true)) {
        autoRestoreTimer = setTimeout(() => {
            void restoreExistingTerminals().catch(err => log(`Auto-connect failed: ${err}`));
        }, 3000);
    }
}

export function deactivate(): void {
    disposing = true;
    if (autoRestoreTimer) { clearTimeout(autoRestoreTimer); }
    for (const connecting of sidebarClients.values()) {
        void connecting.then(connection => connection.disconnect(), () => {});
    }
    sidebarClients.clear();
    sidebarTerminals.clear();
    terminalPtyByTerminal.clear();
    pendingTerminalPtys.length = 0;
    attachedWindowIds.clear();
}

function registerTerminalRenameSync(context: vscode.ExtensionContext): void {
    const trackTerminal = (terminal: vscode.Terminal): TmuxTerminal | null => {
        let pty = terminalPtyByTerminal.get(terminal) ?? getTmuxPtyFromTerminal(terminal);
        if (!pty && looksLikeTmuxTerminal(terminal)) {
            pty = takeNextPendingTerminalPty();
        }
        if (!pty) {
            return null;
        }

        const firstSighting = !terminalPtyByTerminal.has(terminal);
        terminalPtyByTerminal.set(terminal, pty);
        if (firstSighting) {
            // The workbench re-applies the creation-options name ("tmux:<n>")
            // when the terminal process reports ready, discarding whatever the
            // pty emitted before that. processId only resolves after that has
            // happened, so a title sent now is the one the tab keeps.
            void terminal.processId.then(
                () => pty!.reassertTitle(),
                () => { /* terminal went away before it started */ },
            );
        }
        // Detect built-in "Rename…" the instant the user types in this
        // terminal. The pty classifies terminal.name itself so that stale
        // titles (VS Code applying our own rename asynchronously) are never
        // mistaken for user renames and pushed back to tmux.
        pty.setOnInputCallback(() => {
            pty!.maybeSyncNameFromVsCode(terminal.name);
        });
        // Lets the pty notice when VS Code has dropped a tab title it emitted
        // and re-fire it (see TITLE_VERIFY_DELAYS_MS in tmuxTerminalProvider).
        pty.setTerminalNameProvider(() => terminal.name);
        return pty;
    };

    const untrackTerminal = (terminal: vscode.Terminal): void => {
        const pty = terminalPtyByTerminal.get(terminal) ?? getTmuxPtyFromTerminal(terminal);
        terminalPtyByTerminal.delete(terminal);
        const reserved = pty && reservedWindowByPty.get(pty);
        if (reserved) { attachedWindowIds.delete(reserved); }
        for (const [id, tab] of sidebarTerminals) {
            if (tab === terminal) { sidebarTerminals.delete(id); }
        }
        // Hand the pty the reason VS Code gives for the tab disappearing so it
        // can tell a deliberate close (kill the tmux window) from a window
        // reload or workspace switch (keep it). See TmuxTerminal.close().
        pty?.noteTerminalExitReason(terminal.exitStatus?.reason);
    };

    const syncActiveTerminalToTmuxWindow = async (terminal: vscode.Terminal | undefined): Promise<void> => {
        if (!terminal) {
            return;
        }

        const pty = trackTerminal(terminal);
        if (!pty) {
            return;
        }

        // Focus change is a second chance to catch a built-in "Rename…" that
        // happened while the user never typed in the terminal afterwards.
        pty.maybeSyncNameFromVsCode(terminal.name);

        const windowId = pty.getAttachedTmuxWindowId();
        if (!windowId || windowId === activeTmuxWindowId) {
            return;
        }

        await pty.selectWindow().catch((err) => {
            log(`window sync warning (non-fatal): ${err}`);
        });
    };

    // Track already-open terminals on reload before listening for new ones.
    for (const terminal of vscode.window.terminals) {
        trackTerminal(terminal);
    }

    context.subscriptions.push(
        vscode.window.onDidOpenTerminal((terminal) => {
            trackTerminal(terminal);
            // VS Code may not focus terminal when it is opened
            if(pendingUserTerminalFocus && looksLikeTmuxTerminal(terminal)) {
                terminal.show();
                pendingUserTerminalFocus = false;
            }
        }),
        vscode.window.onDidCloseTerminal(untrackTerminal),
        vscode.window.onDidChangeActiveTerminal((terminal) => {
            void syncActiveTerminalToTmuxWindow(terminal);
        }),
    );
}

function getTmuxPtyFromTerminal(terminal: vscode.Terminal): TmuxTerminal | null {
    const options = terminal.creationOptions as vscode.TerminalOptions | vscode.ExtensionTerminalOptions;
    if (!options || !('pty' in options)) {
        return null;
    }
    const pty = (options as vscode.ExtensionTerminalOptions).pty;
    return pty instanceof TmuxTerminal ? pty : null;
}

function looksLikeTmuxTerminal(terminal: vscode.Terminal): boolean {
    return terminal.name === 'tmux' || terminal.name.startsWith('tmux:');
}

function registerPendingTerminalPty(pty: TmuxTerminal): void {
    pendingTerminalPtys.push(pty);
}

function takeNextPendingTerminalPty(): TmuxTerminal | null {
    while (pendingTerminalPtys.length > 0) {
        const candidate = pendingTerminalPtys.shift()!;
        if (![...terminalPtyByTerminal.values()].includes(candidate)) {
            return candidate;
        }
    }
    return null;
}

function registerTerminalProfile(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.window.registerTerminalProfileProvider('tmux-integrated.terminal', {
        async provideTerminalProfile(): Promise<vscode.TerminalProfile> {
            const existing = await claimRestoredWindow();
            if (existing) {
                return new vscode.TerminalProfile(await optionsForWindow(existing));
            }
            const directory = await pickStartDirectory(extensionRootPath);
            if (!directory) { throw new vscode.CancellationError(); }
            return new vscode.TerminalProfile(await createTerminalOptions(directory));
        },
    }));
}

function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tmux-integrated.newTerminal', async () => {
            const startDirectory = await pickStartDirectory(extensionRootPath);
            if (!startDirectory) { return; }
            let options: vscode.ExtensionTerminalOptions;
            try { options = await createTerminalOptions(startDirectory); }
            catch (error) { void vscode.window.showErrorMessage(`tmux-integrated: ${error}`); return; }
            const terminal = vscode.window.createTerminal(options);
            terminal.show();
        }),

        vscode.commands.registerCommand('tmux-integrated.newTerminalInDirectory', async (node?: { directory?: string }) => {
            const base = defaultStartDirectory;
            const input = await vscode.window.showInputBox({
                title: 'New tmux Terminal in Directory',
                prompt: 'Directory on the terminal machine (absolute path, ~/path, or a path relative to the workspace)',
                value: node?.directory ?? base,
                validateInput: async value => {
                    try { await resolveTerminalDirectory(value, base); return undefined; }
                    catch (error) { return String(error); }
                },
            });
            if (input === undefined) { return; }
            try {
                const directory = await resolveTerminalDirectory(input, base);
                const options = await createTerminalOptions(directory);
                vscode.window.createTerminal(options).show();
            } catch (error) { void vscode.window.showErrorMessage(`tmux-integrated: ${error}`); }
        }),

        vscode.commands.registerCommand('tmux-integrated.attachWindow', async () => {
            const windows = await windowStore.list();
            const seen = new Set<string>();
            const items = windows.filter(w => {
                if (seen.has(w.sessionId)) { return false; }
                seen.add(w.sessionId); return true;
            }).map(window => ({ label: window.sessionName, description: window.directory, window }));
            const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a tmux terminal session' });
            if (picked) { await attachManagedWindow(picked.window); }
        }),

        vscode.commands.registerCommand('tmux-integrated.renameTerminal', async () => {
            const terminal = vscode.window.activeTerminal;
            if (!terminal) { return; }
            const pty = terminalPtyByTerminal.get(terminal) ?? getTmuxPtyFromTerminal(terminal);
            if (!pty) {
                vscode.window.showWarningMessage('tmux-integrated: active terminal is not a tmux window.');
                return;
            }
            // In showAutomaticRename mode an empty name is meaningful: it
            // hands the title back to tmux's automatic naming.
            const allowReset = pty.isAutomaticRenameMode();
            const newName = await vscode.window.showInputBox({
                prompt: 'New terminal / tmux session name',
                value: terminal.name,
                validateInput: validateSessionName,
            });
            if (newName === undefined) { return; }
            if (!newName.trim()) {
                if (allowReset) {
                    await pty.resetToAutomaticRename();
                }
                return;
            }
            await pty.renameWindow(newName);
        }),
    );
}

function registerSidebar(context: vscode.ExtensionContext): void {
    treeProvider = new TmuxTreeProvider(windowStore, message => {
        view.message = message ? `Cannot list tmux terminals: ${message}` : undefined;
        if (message) { log(message); }
    });
    const provider = treeProvider;
    const view = vscode.window.createTreeView('tmux-integrated.terminals', { treeDataProvider: provider });
    provider.setVisible(view.visible);
    const refresh = () => { view.message = undefined; provider.refresh(); };
    const guarded = <T extends ManagedWindow | ManagedSession>(action: (item: T) => Promise<void>) => async (window: T | undefined) => {
        if (!window) { return; }
        try { await action(window); refresh(); }
        catch (error) { void vscode.window.showErrorMessage(`tmux-integrated: ${error}`); }
    };
    context.subscriptions.push(provider, view,
        view.onDidChangeVisibility(e => provider.setVisible(e.visible)),
        vscode.commands.registerCommand('tmux-integrated.refreshTerminals', refresh),
        vscode.commands.registerCommand('tmux-integrated.treeAttach', guarded(attachManagedWindow)),
        vscode.commands.registerCommand('tmux-integrated.renameSession', guarded<ManagedSession>(async session => {
            const current = await windowStore.findSession(session);
            const name = await vscode.window.showInputBox({
                prompt: 'New tmux session name (shown by tmux ls)', value: current.sessionName,
                validateInput: validateSessionName,
            });
            if (name !== undefined) { await windowStore.renameSession(current, name); }
        })),
        vscode.commands.registerCommand('tmux-integrated.deleteSession', guarded<ManagedSession>(async session => {
            const current = await windowStore.findSession(session);
            const choice = await vscode.window.showWarningMessage(
                `Delete tmux session "${current.sessionName}"? All its windows and processes will terminate, including windows in other directories or outside this list. All clients attached to this session will exit tmux.`,
                { modal: true }, 'Delete Session',
            );
            if (choice === 'Delete Session') { await windowStore.deleteSession(current); }
        })),
        vscode.commands.registerCommand('tmux-integrated.treeRename', guarded<ManagedWindow>(async window => {
            const session = await windowStore.findSession({ ...window, windows: [] });
            const name = await vscode.window.showInputBox({
                prompt: 'New terminal / tmux session name', value: session.sessionName, validateInput: validateSessionName,
            });
            if (name !== undefined) { await windowStore.renameSession(session, name); }
        })),
        vscode.commands.registerCommand('tmux-integrated.treeDelete', guarded<ManagedWindow>(async window => {
            const session = await windowStore.findSession({ ...window, windows: [] });
            const choice = await vscode.window.showWarningMessage(
                `Delete terminal "${session.sessionName}" and its tmux session? All ${session.windows.length} window(s) and their processes will terminate; attached clients will exit.`,
                { modal: true }, 'Delete',
            );
            if (choice === 'Delete') { await windowStore.deleteSession(session); }
        })),
    );
}

async function connectSession(window: ManagedWindow): Promise<TmuxControlClient> {
    let connecting = sidebarClients.get(window.sessionId);
    if (!connecting) {
        connecting = (async () => {
            const binary = resolveTmuxBinaryPath();
            const connection = new TmuxControlClient(window.sessionId, binary, vscode.env.appRoot, globalStoragePath);
            connection.setVersion(execFileSync(binary, ['-V'], { encoding: 'utf8' }).trim());
            connection.on('tmux-exit', () => { sidebarClients.delete(window.sessionId); treeProvider?.refresh(); });
            try {
                await connection.connect({ attachOnly: true });
                await connection.updateEnvironment(collectVscodeEnvVars());
                if (disposing) { throw new Error('Extension is shutting down'); }
                return connection;
            } catch (error) { connection.disconnect(); throw error; }
        })();
        sidebarClients.set(window.sessionId, connecting);
    }
    try { return await connecting; }
    catch (error) { sidebarClients.delete(window.sessionId); throw error; }
}

async function optionsForWindow(window: ManagedWindow): Promise<vscode.ExtensionTerminalOptions> {
    attachedWindowIds.add(window.windowId);
    try {
        const connection = await connectSession(window);
        const pty = new TmuxTerminal(connection, window.directory, collectVscodeEnvVars(), undefined, false, {
            windowId: window.windowId, paneId: window.paneId, windowIndex: window.windowIndex,
            name: window.sessionName, automaticRename: false,
        }, {
            onWindowAttached: () => { treeProvider?.refresh(); },
            onWindowDetached: () => { attachedWindowIds.delete(window.windowId); treeProvider?.refresh(); },
        }, () => disposing, log,
        () => vscode.workspace.getConfiguration('tmux-integrated').get<boolean>('destroyWindowOnClose', false),
        {
            rename: name => windowStore.renameSession({ ...window, windows: [] }, name),
            destroy: () => windowStore.deleteSession({ ...window, windows: [] }),
        });
        reservedWindowByPty.set(pty, window.windowId);
        sessionIdByPty.set(pty, window.sessionId);
        registerPendingTerminalPty(pty);
        setStatus(`$(terminal) tmux: ${window.sessionName}`);
        return { name: window.sessionName, pty };
    } catch (error) { attachedWindowIds.delete(window.windowId); throw error; }
}

async function createTerminalOptions(directory: string): Promise<vscode.ExtensionTerminalOptions> {
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const window = await windowStore.create(directory, cfg.get<string>('sessionName'), cfg.get<string>('shell') || process.env.SHELL);
    treeProvider?.refresh();
    // If attaching fails, retain the newly created session so it can be retried from the sidebar.
    return optionsForWindow(window);
}

async function attachManagedWindow(window: ManagedWindow): Promise<void> {
    const session = await windowStore.findSession({ ...window, windows: [] });
    const current = session.windows[0];
    const showExisting = (): boolean => {
        const tab = sidebarTerminals.get(current.sessionId) ?? [...terminalPtyByTerminal].find(([, pty]) =>
            sessionIdByPty.get(pty) === current.sessionId)?.[0];
        if (tab) { tab.show(); return true; }
        return false;
    };
    if (showExisting()) { return; }
    // Await the shared connection before claiming the tab; concurrent clicks recheck below.
    await connectSession(current);
    if (showExisting()) { return; }
    if (attachedWindowIds.has(current.windowId)) { return; }
    attachedWindowIds.add(current.windowId);
    const options = await optionsForWindow(current);
    const terminal = vscode.window.createTerminal(options);
    sidebarTerminals.set(current.sessionId, terminal);
    terminal.show();
}

async function claimRestoredWindow(): Promise<ManagedWindow | undefined> {
    restoreQueue ??= windowStore.list().then(windows => {
        const directories = vscode.workspace.workspaceFolders?.map(folder => resolveStartDirectory(extensionRootPath, folder)) ?? [defaultStartDirectory];
        const seen = new Set<string>();
        return windows.filter(window => {
            if (!window.managed || !directories.includes(window.directory) || seen.has(window.sessionId)) { return false; }
            seen.add(window.sessionId);
            return true;
        });
    });
    const queue = await restoreQueue;
    while (queue.length) {
        const window = queue.shift()!;
        if (!attachedWindowIds.has(window.windowId)) {
            attachedWindowIds.add(window.windowId);
            return window;
        }
    }
    return undefined;
}

async function restoreExistingTerminals(): Promise<void> {
    let window: ManagedWindow | undefined;
    while (!disposing && (window = await claimRestoredWindow())) {
        const options = await optionsForWindow(window);
        const terminal = vscode.window.createTerminal(options);
        sidebarTerminals.set(window.sessionId, terminal);
    }
}

// ---------------------------------------------------------------------------
// Helpers — misc
// ---------------------------------------------------------------------------

function setStatus(text: string, tooltip?: string): void {
    if (!statusBar) { return; }
    statusBar.text = text;
    if (tooltip) { statusBar.tooltip = tooltip; }
}

function resolveStartDirectory(
    extensionPath: string,
    folder = vscode.workspace.workspaceFolders?.[0],
): string {
    const workspaceFolder = folder?.uri.fsPath;

    // 1. tmux-integrated.cwd
    const cfg = vscode.workspace.getConfiguration('tmux-integrated', folder?.uri);
    const cwdSetting = cfg.get<string>('cwd');
    if (cwdSetting) {
        return resolveVariables(cwdSetting, workspaceFolder, extensionPath);
    }

    // 2. terminal.integrated.cwd
    const termCwd = vscode.workspace
        .getConfiguration('terminal.integrated', folder?.uri)
        .get<string>('cwd');
    if (termCwd) {
        return resolveVariables(termCwd, workspaceFolder, extensionPath);
    }

    // 3. Workspace folder
    return workspaceFolder || extensionPath;
}

async function pickStartDirectory(extensionPath: string): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length <= 1) {
        return resolveStartDirectory(extensionPath, folders?.[0]);
    }

    const picked = await vscode.window.showQuickPick(
        folders.map((workspaceFolder) => ({
            label: workspaceFolder.name,
            description: workspaceFolder.uri.fsPath,
            workspaceFolder,
        })),
        { placeHolder: 'Select current working directory for new tmux terminal' },
    );
    return picked
        ? resolveStartDirectory(extensionPath, picked.workspaceFolder)
        : undefined;
}

/**
 * Resolve common VS Code predefined variables in a string value.
 * See https://code.visualstudio.com/docs/editor/variables-reference
 */
function resolveVariables(value: string, workspaceFolder: string | undefined, fallbackDir: string): string {
    const vars: Record<string, string | undefined> = {
        workspaceFolder,
        workspaceFolderBasename: workspaceFolder ? path.basename(workspaceFolder) : undefined,
        userHome: process.env.HOME ?? process.env.USERPROFILE,
        pathSeparator: path.sep,
    };
    return value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
        return vars[name] ?? fallbackDir;
    });
}

function resolveTmuxBinaryPath(): string {
    // Just use 'tmux' and let the OS resolve it from PATH.
    // Verify it's actually callable.
    execFileSync('tmux', ['-V'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    return 'tmux';
}

function log(message: string): void {
    outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Read `terminal.integrated.defaultProfile.<os>` for the current platform.
 * Returns `null` if unset. Used to gate the stray-shell auto-close so we
 * never dispose user-opened terminals when the default profile isn't ours.
 */
function currentPlatformDefaultProfile(): string | null {
    const key = process.platform === 'darwin' ? 'osx'
        : process.platform === 'win32' ? 'windows'
        : 'linux';
    const v = vscode.workspace
        .getConfiguration('terminal.integrated')
        .get<string>(`defaultProfile.${key}`);
    return v && v.length > 0 ? v : null;
}

function isTmuxIntegratedDefaultProfile(): boolean {
    return currentPlatformDefaultProfile() === 'tmux-integrated';
}

/**
 * Collect the VS Code environment variables that should be forwarded into
 * every new tmux window so that editor-integration commands keep working.
 *
 * • VSCODE_IPC_HOOK_CLI  — lets `code <file>` talk to the running VS Code.
 * • GIT_ASKPASS / VSCODE_GIT_* — git credential and signing helpers.
 */
function collectVscodeEnvVars(): Record<string, string> {
    const keys = [
        'VSCODE_IPC_HOOK_CLI',
        'GIT_ASKPASS',
        'VSCODE_GIT_ASKPASS_NODE',
        'VSCODE_GIT_ASKPASS_MAIN',
        'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
        'VSCODE_GIT_IPC_HANDLE',
    ];

    const vars: Record<string, string> = {};
    for (const k of keys) {
        const v = process.env[k];
        if (v) { vars[k] = v; }
    }
    return vars;
}
