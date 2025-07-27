import * as vscode from 'vscode';
import { extname } from 'path';
import { Ignore } from 'ignore';

import { readIgnores } from './utils/ignore';
import { FileClassifier } from './utils/file-classifier';
import { Generator } from './generator';
import { CallGraphPanel } from './webview';
import { getLanguages } from './utils/languages';
import { Console } from 'console';

export class CommandManager {
  private context: vscode.ExtensionContext;

	// TODO: listen to .gitignore file modifications
	private ignores: Map<string, Ignore>;

	private languages: Map<string, string>;

  public constructor(context: vscode.ExtensionContext) {
    this.context = context;
		this.ignores = new Map();
		this.languages = getLanguages();
  }

  public async createConfigTemplate() {
	const config = {
	  input_files: [{
		filepath: '<full path to the file, use / instead of \\>',
		canvas: { x: 0, y: 0 },
	  }],
	  output_file: '<full path to the output file>'
	};

	const configContent = JSON.stringify(config, null, 2);
	const uri = await vscode.window.showSaveDialog({
	  defaultUri: vscode.Uri.joinPath(this.context.extensionUri, 'crabviz_config.json'),
	  filters: { 'JSON files': ['json'] },
	});

	if (uri) {
	  await vscode.workspace.fs.writeFile(uri, Buffer.from(configContent, 'utf8'));
	  vscode.window.showInformationMessage(`Config template saved to ${uri.path}`);
	}
  }

  public async generateCallGraphFromConfig() {
	  const config_filename = 'crabviz_config.json';
	  //search for crabviz_config.json in opened workspace
	  vscode.workspace.findFiles(`**/${config_filename}`, '**/node_modules/**', 1).then(files => {
		  if (files.length === 0) {
			  vscode.window.showErrorMessage(`No ${config_filename} file found in the workspace`);
			  return;
		  }
		  console.debug(`Found ${files.length} ${config_filename} files in the workspace`);

		  const uri = files[0];
		  vscode.workspace.fs.readFile(uri).then(buffer => {
			  console.debug(`Reading ${config_filename} file from ${uri.path}`);
			  const configContent = buffer.toString();
			  let config;
			  try {
				  config = JSON.parse(configContent);
				  console.debug(`Parsed ${config_filename}:`, config);
			  } catch (e) {
				  vscode.window.showErrorMessage(`Failed to parse ${config_filename}: ${e}`);
				  return;
			  }

			  let selections: vscode.Uri[] = [];
			  let canvasPositions: [string, number, number][] = [];
			  for (const c of config.input_files) {
				//create vscode.Uri from complete file path
				  const fileUri = vscode.Uri.file(c.filepath.replace('C:/', 'c:/'));  
				  const filename = c.filepath.split('/').pop() || '';
				  canvasPositions.push([filename, c.canvas.x, c.canvas.y]);
				  selections.push(fileUri);
	          }

			  console.debug(`Selected files:`, selections);
			  console.debug(`Canvas positions:`, canvasPositions);
			  this.generateCallGraph(selections[0], selections, canvasPositions, config.output_file);
		  });
	  });
  }

  public async generateCallGraph(contextSelection: vscode.Uri, allSelections: vscode.Uri[], canvasPositions: [string, number, number][] = [], savePath: string = '') {
		let cancelled = false;

		// selecting no file is actually selecting the entire workspace
		if (allSelections.length === 0) {
			allSelections.push(contextSelection);
		}

		let root = vscode.workspace.getWorkspaceFolder(contextSelection);
		if (canvasPositions.length === 0) {
			root = vscode.workspace.workspaceFolders!
				.find(folder => contextSelection.path.startsWith(folder.uri.path))!;
		}
		console.debug(`Root workspace folder: ${root?.name} (${root?.uri.path})`);

		if (!root) {
			vscode.window.showErrorMessage("No workspace folder found for the selected file");
			return;
		}
		
		const ig = await this.readIgnores(root);

		for await (const uri of allSelections) {
			if (!uri.path.startsWith(root.uri.path)) {
				vscode.window.showErrorMessage("Can not generate call graph across multiple workspace folders");
				console.debug(`Selected file ${uri.path} is not in the root workspace folder ${root.uri.path}`);
				return;
			}
		}
		// classify files by programming language

		const files = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Detecting project languages",
			cancellable: true
		}, (_, token) => {
			token.onCancellationRequested(() => cancelled = true);

			const classifer = new FileClassifier(root.uri.path, this.languages, ig);
			return classifer.classifyFilesByLanguage(allSelections, token);
		});

		if (cancelled) {
			return;
		}

		const languages = Array.from(files.keys()).map(lang => ({ label: lang }));
		let lang: string;
		if (languages.length > 1) {
			const selectedItem = await vscode.window.showQuickPick(languages, {
				title: "Pick a language to generate call graph",
			});

			if (!selectedItem) {
				return;
			}
			lang = selectedItem.label;
		} else if (languages.length === 1) {
			lang = languages[0].label;
		} else {
			return;
		}

		

		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Crabviz: Generating call graph",
			cancellable: true,
		}, (progress, token) => {
			token.onCancellationRequested(() => cancelled = true);

			const generator = new Generator(root.uri, lang);
			return generator.generateCallGraph(files.get(lang)!, progress, token);
		})
		.then(svg => {
			if (cancelled) { return; }
			
			const panel = new CallGraphPanel(this.context.extensionUri);
			panel.showCallGraph(svg, false);

			// const savePath = vscode.workspace.getConfiguration('crabviz').get('obsidianCanvasSavePath') as string | undefined;
			// if (!savePath) {
			// 	vscode.window.showErrorMessage("Obsidian Canvas save path is not configured. Please set 'crabviz.obsidianCanvasSavePath' in settings.");
			// 	return;
			// }
			console.debug("Obsidian Canvas save path:", savePath);

			//<g id=\"(.*?):(.*?)\"><a.*?>\n<path.*?\/>\n<text.*?>(.*?)<\/text>\n<\/a>\n<\/g>
			//<g id=\"(.*?)\"><a.*?>\n<text.*?>(.*?)<\/text>\n<\/a>\n<\/g>
			//<g id=\"(.*?)\&#45;&gt;(.*?)\" class="edge">

			const class_regex = /class="(.*?)"/g;
			svg = svg.replaceAll(class_regex, (match, className) => {
				console.debug(`Replaced class name: ${className} with ${className.replaceAll(/ /g, '_')}`);
				return `class="${className.replaceAll(/ /g, '_')}"`;
			});

			let edges = [];
			let functions = [];

			const { DOMParser } = require('xmldom');	
			const doc = new DOMParser().parseFromString(svg, 'text/html');
			const cells = doc.getElementsByTagName('g');
			console.debug("SVG cells:", cells);
			for (let i = 0; i < cells.length; i++) {
				const cell = cells[i];
				console.debug(`Cell ${i} attributes:`, cell.attributes);
				const className = cell.getAttribute('class');
				const cellId = cell.getAttribute('id');
				console.debug(`Cell ${i}: class=${className}, id=${cellId}`);

				if(className === "edge"){
					const directionSplit = cellId.split(' -> ');
					if (directionSplit.length !== 2) {
						console.warn(`Invalid edge format: ${cellId}`);
						continue;
					}
					const from_file_id = directionSplit[0].split(':')[0];
					const from = directionSplit[0].split(':')[1];
					const to_file_id = directionSplit[1].split(':')[0];
					const to = directionSplit[1].split(':')[1];
					edges.push({
						"from_file_id": from_file_id,
						"from": from,
						"to_file_id": to_file_id,
						"to": to,
						canvas_id: generateAlphaNumericId(16)
					});
				}else if (className === '' && cellId && cellId.includes(':')) {
					// This is a function node
					const parts = cellId.split(':');
					if (parts.length !== 2) {
						console.warn(`Invalid function node format: ${cellId}`);
						continue;
					}
					const file_id = parts[0];
					const function_id = parts[1];
					const textElement = cell.getElementsByTagName('text')[0];
					if (!textElement) {
						console.warn(`No text element found for function node: ${cellId}`);
						continue;
					}
					const name = textElement.textContent || '';
					console.debug(`Function node: file_id=${file_id}, function_id=${function_id}, name=${name}`);

					// calculate depth of parent nodes
					let depth = 0;
					let parent = cell.parentNode;
					while (parent && parent.tagName !== 'svg') {
						if (parent.tagName === 'g' && parent.getAttribute('id') && parent.getAttribute('id').includes(':')) {
							depth++;
						}
						parent = parent.parentNode;
					}

					functions.push({
						file_id: file_id,
						function_id: function_id,
						name: name,
						depth: depth
					});
				}
			}

			//use regex to find nodes and edges in the SVG
			// const functionRegex = /<g id="(.*?):(.*?)"><a.*?>\n<path.*?\/>\n<text.*?>(.*?)<\/text>\n<\/a>\n<\/g>/g;
			const filenameRegex = /<g id="(.*?)"><a.*?>\n<text.*?>(.*?)<\/text>\n<\/a>\n<\/g>/g;
			// const edgeRegex = /<g id="(.*?):(.*?) \&#45;&gt; (.*?):(.*?)" class="edge">/g;

			let filenames = [];
			let match;
			while ((match = filenameRegex.exec(svg)) !== null) {
				//get all functions nodes with matching id
				let funcs = [];
				for (const func of functions) {
					if (match[1].startsWith(func.file_id)) {
						funcs.push({
							function_id: func.function_id,
							function_name: func.name,
							canvas_id: generateAlphaNumericId(16),
							function_depth: func.depth
						});
					}
				}

				filenames.push({
					file_id: match[1],
					file_name: match[2],
					functions: funcs
				});
			}
			console.debug("Found filenames:", filenames);

			
			// while ((match = functionRegex.exec(svg)) !== null) {
			// 	functions.push({
			// 		file_id: match[1],
			// 		function_id: match[2],
			// 		name: match[3]
			// 	});
			// }
			// console.debug("Found functions:", functions);

			
			console.debug("Found edges:", edges);

			//group functions by file_id
			// for(let f_index = 0; f_index < functions.length; f_index++) {
			// 	const func = functions[f_index];
			// 	const file = filenames.find(f => f.file_id.startsWith(func.file_id));
			// 	if (file) {
			// 		file.functions.push({
			// 			function_id: func.function_id,
			// 			function_name: func.name,
			// 			canvas_id: "",
			// 			function_depth: func.depth
			// 		});
			// 	} else {
			// 		console.warn(`File with id ${func.file_id} not found for function ${func.name}`);
			// 	}
			// }
			console.debug("Grouped filenames with functions:", filenames);

			function generateAlphaNumericId(length: number): string {
				const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
				let result = '';
				for (let i = 0; i < length; i++) {
					result += characters.charAt(Math.floor(Math.random() * characters.length));
				}
				return result;
			}

			for (const selection of allSelections) {
				console.debug(`Processing selection: ${selection.path}`);
			}

			//if output file exists
			vscode.workspace.fs.stat(vscode.Uri.file(savePath)).then((exists) => {
				let canvas_lines: string[] = [];

				if (exists) {
					vscode.window.showWarningMessage(`Obsidian Canvas file already exists at ${savePath}. It will be overwritten.`);
					//read json file
					vscode.workspace.fs.readFile(vscode.Uri.file(savePath)).then((data) => {
						canvas_lines = data.toString().split('\n');
						console.debug("Canvas lines before removing existing nodes:");
						for (const line of canvas_lines) {
							console.debug(line);
						}
						console.debug('\n\n');

						let new_canvas_lines = [];

						for (let ln = 0; ln < canvas_lines.length; ln++) {
							if(canvas_lines[ln].includes(`"type":"group"`)) {
								let groupExists = false;
								for (const file of filenames) {
									if (canvas_lines[ln].includes(`"label":"${file.file_name}"`)) {
										console.debug(`Removing existing group node for file: ${file.file_name}`);
										groupExists = true;
										break;
									}
								}
								if (groupExists) {
									continue; // skip existing group nodes
								}
								new_canvas_lines.push(canvas_lines[ln]);
							}else if(canvas_lines[ln].includes(`"type":"text"`)){
								if (canvas_lines[ln].includes("](vscode://file")) {
									continue;
								}
								new_canvas_lines.push(canvas_lines[ln]);
							}else{
								new_canvas_lines.push(canvas_lines[ln]);
							}
						}
						console.debug("Canvas lines after removing existing nodes:");
						for (const line of new_canvas_lines) {
							console.debug(line);
						}
						console.debug('\n\n');
						canvas_lines = new_canvas_lines;

						let canvas_nodes = [];
				const node_width = 500;
				const node_height = 60;
				const node_padding = 20;
				const group_padding = 20;
				const group_width = node_width + 2 * group_padding;
				const depth_padding = 30; // padding for depth indentation
				
				let file_x_offset = 0;
				let file_y_offset = 0;
				
				for(let file_index = 0; file_index < filenames.length; file_index++) {
					const canvasPosition = canvasPositions.find(p => p[0] === filenames[file_index].file_name);
					if (canvasPosition) {
						file_x_offset = canvasPosition[1];
						file_y_offset = canvasPosition[2];
					}else{
						file_x_offset = file_index * (group_width + 100); // 100 is the padding between groups
						file_y_offset = 0; // reset y offset for each file
					}

					const functions = filenames[file_index].functions;
					if (functions.length === 0) {
						continue; // skip files with no functions
					}
					let file_uri = '';
					for (const selection of allSelections) {
						if (selection.path.endsWith(filenames[file_index].file_name)) {
							file_uri = selection.path.replaceAll(' ', '%20'); // replace spaces with %20 for URI encoding
							break;
						}
					}
					let function_y_offset = file_y_offset; // start above the file group
					for(let function_index = 0; function_index < functions.length; function_index++) {					
						const func = functions[function_index];
						if (func.function_id === "default") {
							continue; // skip default function
						}
						const file_line = (parseInt(func.function_id.split('_')[0]) + 1).toString(); // +1 to convert 0-based index to 1-based line number
						const file_column = func.function_id.split('_')[1];
						const canvas_id = generateAlphaNumericId(16);
						func.canvas_id = canvas_id; // assign canvas id to function


						canvas_nodes.push({
							"id": canvas_id,
							"type": "text",
							"text": `**${func.function_name}**\n[${file_line + ":" + file_column + " " + filenames[file_index].file_name}](vscode://file${file_uri + ":" + file_line + ":" + file_column})`,
							"x": file_x_offset + (func.function_depth * depth_padding), // indent based on depth
							"y": function_y_offset,
							"width": node_width - (func.function_depth * depth_padding), // reduce width based on depth
							"height": node_height,
						});
						function_y_offset += (node_height + node_padding); // 20 is the padding between nodes
					}

					canvas_nodes.push({
						"id": generateAlphaNumericId(16),
						"type": "group",
						"label": filenames[file_index].file_name,
						"x": (file_x_offset - group_padding),
						"y": (file_y_offset - group_padding),
						"width": group_width,
						"height": (function_y_offset - file_y_offset) + group_padding, // 60 is the height of each node, 50 is the padding
					});
				}

				let canvas_edges = [];
				for(let edge_index = 0; edge_index < edges.length; edge_index++) {
					const edge = edges[edge_index];
					const fromFile = filenames.find(f => f.file_id.includes('_' + edge.from_file_id + '_'));
					const toFile = filenames.find(f => f.file_id.includes('_' + edge.to_file_id + '_'));
					if (!fromFile || !toFile) {
						console.warn(`Edge from ${edge.from_file_id}:${edge.from} to ${edge.to_file_id}:${edge.to} not found`);
						continue;
					}

					const fromNode = fromFile.functions.find(f => (f.function_id === edge.from));
					const toNode = toFile.functions.find(f => (f.function_id === edge.to));
					console.debug(`Processing edge from ${edge.from} to ${edge.to}`, fromNode, toNode);
					if (fromNode && toNode) {
						if (fromFile !== toFile) {
							canvas_edges.push({
								"id": edge.canvas_id,
								"fromNode": fromNode.canvas_id,
								"fromSide": "right",
								"toNode": toNode.canvas_id,
								"toSide": "left",
								"color": "6"
							});
						}else{
							canvas_edges.push({
								"id": edge.canvas_id,
								"fromNode": fromNode.canvas_id,
								"fromSide": "left",
								"toNode": toNode.canvas_id,
								"toSide": "left",
								"color": "4"
							});
						}
						
					} else {
						console.warn(`Edge from ${edge.from} to ${edge.to} not found`);
					}
				}
				
				let nodes_line_num = canvas_lines.findIndex(line => line.includes('"nodes":['));
				let edges_line_num = canvas_lines.findIndex(line => line.includes('"edges":['));
				if (nodes_line_num === -1 || edges_line_num === -1) {
					canvas_lines.push('{\n');
					canvas_lines.push('"nodes":[\n');
					canvas_lines.push('],\n');
					canvas_lines.push('"edges":[\n');
					canvas_lines.push(']\n');
					canvas_lines.push('}');
				}

				nodes_line_num = canvas_lines.findIndex(line => line.includes('"nodes":['));
				for (let n = 0; n < canvas_nodes.length; n++) {
					const node = canvas_nodes[n];
					canvas_lines.splice(nodes_line_num + n + 1, 0, JSON.stringify(node) + ',');
				}
				edges_line_num = canvas_lines.findIndex(line => line.includes('"edges":['));
				for (let e = 0; e < canvas_edges.length; e++) {
					const edge = canvas_edges[e];
					canvas_lines.splice(edges_line_num + e + 1, 0, JSON.stringify(edge) + ',');
				}

				for(let ln = canvas_lines.length - 1; ln >= 0; ln--) {
					if(canvas_lines[ln].trim().startsWith(']')) {
						if(canvas_lines[ln - 1].trim().endsWith(',')) {
							canvas_lines[ln - 1] = canvas_lines[ln - 1].trim().slice(0, -1); // remove trailing comma
						}
					}
				}

				console.debug("Canvas lines after adding nodes and edges:");
				for (const line of canvas_lines) {
					console.debug(line);
				}
			}).then(() => {
				console.debug("Writing canvas lines to file:", savePath);
				//write canvas_lines to file
				const canvasContent = canvas_lines.join('\n');
				vscode.workspace.fs.writeFile(vscode.Uri.file(savePath), Buffer.from(canvasContent, 'utf8'))
					.then(() => {
						vscode.window.showInformationMessage(`Obsidian Canvas file saved at ${savePath}`);
					});
				
			});
		}});	
		});
	}		

	public async loadSVG(contextSelection: vscode.Uri, allSelections: vscode.Uri[]) {
		if (allSelections.length === 0) {
			allSelections.push(contextSelection);
		}

		const root = vscode.workspace.workspaceFolders!
			.find(folder => contextSelection.path.startsWith(folder.uri.path))!;

		const ig = await this.readIgnores(root);

		for await (const uri of allSelections) {
			if (!uri.path.startsWith(root.uri.path)) {
				vscode.window.showErrorMessage("Can not load SVG across multiple workspace folders");
				return;
			}
		}

		let svg = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Crabviz: Loading SVG",
			cancellable: true,
		}, (progress, token) => {
			token.onCancellationRequested(() => {
				svg = "";
			});

			let filestring = vscode.workspace.fs.readFile(allSelections[0])
				.then(buffer => {
					return buffer.toString();
				});
			return filestring;
		}).then((svg) => {
			if (!svg) {
				vscode.window.showErrorMessage('No SVG content found');
				return;
			}

			const panel = new CallGraphPanel(this.context.extensionUri);
			panel.showCallGraph(svg, false);

			return svg;
		});
	}

  public async generateFuncCallGraph(editor: vscode.TextEditor) {
		const uri = editor.document.uri;
		const anchor = editor.selection.start;

		const root = vscode.workspace.workspaceFolders!
			.find(folder => uri.path.startsWith(folder.uri.path))!;

		const ig = await this.readIgnores(root);

		const lang = this.languages.get(extname(uri.path)) ?? "";

		const generator = new Generator(root.uri, lang);

		vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title: "Crabviz: Generating call graph",
		}, _ => {
			return generator.generateFuncCallGraph(uri, anchor, ig);
		})
		.then(svg => {
			if (!svg) {
				vscode.window.showErrorMessage('No results');
				return;
			}

			const panel = new CallGraphPanel(this.context.extensionUri);
			panel.showCallGraph(svg, true);
		});
	}

	async readIgnores(root: vscode.WorkspaceFolder): Promise<Ignore> {
		if (this.ignores.has(root.uri.path)) {
			return this.ignores.get(root.uri.path)!;
		} else {
			const ig = await readIgnores(root);
			this.ignores.set(root.uri.path, ig);

			return ig;
		}
	}
}
