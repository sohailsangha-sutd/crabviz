import * as vscode from 'vscode';

import { initSync, set_panic_hook } from '../crabviz';
import { CallGraphPanel } from './webview';
import { CommandManager } from './command_manager';

export async function activate(context: vscode.ExtensionContext) {
	await vscode.workspace.fs.readFile(
		vscode.Uri.joinPath(context.extensionUri, 'crabviz/index_bg.wasm')
	).then(bits => {
		initSync(bits);
		set_panic_hook();
	});

	let manager = new CommandManager(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('crabviz.generateCallGraphFromConfig', manager.generateCallGraphFromConfig.bind(manager)),
		vscode.commands.registerCommand('crabviz.createConfigTemplate', manager.createConfigTemplate.bind(manager)),
		vscode.commands.registerCommand('crabviz.generateCallGraph', manager.generateCallGraph.bind(manager)),
		vscode.commands.registerCommand('crabviz.loadSVG', manager.loadSVG.bind(manager)),
		vscode.commands.registerTextEditorCommand('crabviz.generateFuncCallGraph', manager.generateFuncCallGraph.bind(manager)),
		vscode.commands.registerCommand('crabviz.exportCallGraph', () => {
			CallGraphPanel.currentPanel?.exportSVG();
		}),
		vscode.commands.registerCommand('crabviz.exportCrabViz', () => {
			CallGraphPanel.currentPanel?.exportCrabViz();
		}),
		vscode.commands.registerCommand('crabviz.saveJSON', () => {
			CallGraphPanel.currentPanel?.exportJSON();
		})
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
