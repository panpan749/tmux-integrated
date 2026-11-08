import * as vscode from 'vscode';
import * as path from 'path';
import { ManagedWindow, TmuxWindowStore } from './tmuxWindowStore';

type DirectoryNode = { directory: string; windows: ManagedWindow[] };
export type TmuxTreeNode = DirectoryNode | ManagedWindow;

export class TmuxTreeProvider implements vscode.TreeDataProvider<TmuxTreeNode>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<TmuxTreeNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private timer: ReturnType<typeof setInterval> | undefined;
    private fingerprint = '';
    private loading: Promise<ManagedWindow[]> | undefined;

    constructor(private readonly store: TmuxWindowStore, private readonly reportError: (message: string | undefined) => void) {}

    refresh(): void { this.changed.fire(undefined); }

    setVisible(visible: boolean): void {
        if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
        if (visible) {
            this.refresh();
            // Poll only while visible: captures changes from other VS Code/tmux clients too.
            this.timer = setInterval(() => { void this.checkForChanges(); }, 3000);
        }
    }

    private async load(): Promise<ManagedWindow[]> {
        if (!this.loading) {
            this.loading = this.store.list().finally(() => { this.loading = undefined; });
        }
        return this.loading;
    }

    private async checkForChanges(): Promise<void> {
        try {
            const next = JSON.stringify(await this.load());
            if (next !== this.fingerprint) { this.refresh(); }
        } catch { /* getChildren reports failures on explicit refresh */ }
    }

    async getChildren(element?: TmuxTreeNode): Promise<TmuxTreeNode[]> {
        if (element) {
            return 'windows' in element ? element.windows : [];
        }
        try {
            const windows = await this.load();
            this.reportError(undefined);
            this.fingerprint = JSON.stringify(windows);
            const groups = new Map<string, ManagedWindow[]>();
            const seen = new Set<string>();
            for (const window of windows) {
                if (seen.has(window.sessionId)) { continue; }
                seen.add(window.sessionId);
                const group = groups.get(window.directory) ?? [];
                group.push(window);
                groups.set(window.directory, group);
            }
            return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([directory, windows]) => ({
                directory, windows: windows.sort((a, b) => a.sessionName.localeCompare(b.sessionName)),
            }));
        } catch (error) {
            this.reportError(String(error));
            return [];
        }
    }

    getTreeItem(element: TmuxTreeNode): vscode.TreeItem {
        if ('windows' in element) {
            const item = new vscode.TreeItem(path.basename(element.directory) || element.directory, vscode.TreeItemCollapsibleState.Expanded);
            item.id = `directory:${element.directory}`;
            item.description = element.directory;
            item.tooltip = element.directory;
            item.iconPath = new vscode.ThemeIcon('folder');
            item.contextValue = 'tmuxDirectory';
            return item;
        }
        const item = new vscode.TreeItem(element.sessionName, vscode.TreeItemCollapsibleState.None);
        item.id = `session:${element.sessionId}`;
        item.description = element.managed === false ? `native tmux · ${element.sessionId}` : element.sessionId;
        item.tooltip = `${element.sessionName}\n${element.directory}\ntmux attach -t ${element.sessionId}`;
        item.iconPath = new vscode.ThemeIcon('terminal');
        item.contextValue = 'tmuxWindow';
        item.command = { command: 'tmux-integrated.treeAttach', title: 'Attach', arguments: [element] };
        return item;
    }

    dispose(): void {
        if (this.timer) { clearInterval(this.timer); }
        this.changed.dispose();
    }
}
