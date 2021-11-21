/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
  workspace as Workspace,
  events,
  Document,
  window as Window,
  commands as Commands,
  languages as Languages,
  Disposable,
  ExtensionContext,
  Uri,
  TextDocument,
  CodeActionContext,
  Diagnostic,
  ProviderResult,
  Command,
  QuickPickItem,
  WorkspaceFolder as VWorkspaceFolder,
  MessageItem,
  DiagnosticSeverity as VDiagnosticSeverity,
  Range,
  Position,
  LanguageClient,
  LanguageClientOptions,
  TransportKind,
  NotificationType,
  ErrorHandler,
  ErrorAction,
  CloseAction,
  State as ClientState,
  RevealOutputChannelOn,
  ServerOptions,
  DocumentFilter,
} from 'coc.nvim';
import path from 'path';
import fs from 'fs';
import {
  CodeActionKind,
  VersionedTextDocumentIdentifier,
  ExecuteCommandParams,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidChangeConfigurationNotification,
  ExecuteCommandRequest,
  CodeActionRequest,
  CodeActionParams,
  CodeAction,
} from 'vscode-languageserver-protocol';
import { configFiles, linter, eslintAlwaysAllowExecutionKey, eslintExecutionKey } from '../constants';
import {
  CodeActionsOnSaveMode,
  ConfigurationSettings,
  ConfirmationSelection,
  ConfirmExecution,
  ConfirmExecutionParams,
  ConfirmExecutionResult,
  DirectoryItem,
  ESLintExecutionState,
  ESLintSeverity,
  ExecutionInfo,
  ExecutionParams,
  Is,
  LegacyDirectoryItem,
  ModeItem,
  NoConfigRequest,
  NoESLintLibraryRequest,
  NoESLintState,
  OpenESLintDocRequest,
  PatternItem,
  ProbeFailedRequest,
  ResourceInfo,
  ShowOutputChannel,
  Status,
  StatusNotification,
  StatusParams,
  Validate,
  ValidateItem,
} from './types';
import { convert2RegExp, findEslint, Semaphore, toOSPath, toPosixPath } from './utils';

let lastExecutionInfo: ExecutionInfo | undefined;
export let onActivateCommands: Disposable[] | undefined;
export let eslintAlwaysAllowExecutionState = false;
export let eslintExecutionState: ESLintExecutionState;
export const exitCalled = new NotificationType<[number, string]>('eslint/exitCalled');

export const setOnActivateCommands = (commands: Disposable[]) => {
  onActivateCommands = commands;
};
export const setEslintAlwaysAllowExecutionState = (newState: boolean) => {
  eslintAlwaysAllowExecutionState = newState;
};
export const setEslintExecutionState = (newState: ESLintExecutionState) => {
  eslintExecutionState = newState;
};

export async function pickFolder(
  folders: ReadonlyArray<VWorkspaceFolder>,
  placeHolder: string
): Promise<VWorkspaceFolder | undefined> {
  if (folders.length === 1) {
    return Promise.resolve(folders[0]);
  }

  const selected = await Window.showQuickpick(
    folders.map<string>((folder) => {
      return folder.name;
    }),
    placeHolder
  );
  if (selected === -1) {
    return undefined;
  }
  return folders[selected];
}

export function createDefaultConfiguration(): void {
  const folders = Workspace.workspaceFolders;
  if (!folders) {
    Window.showErrorMessage(
      'An ESLint configuration can only be generated if VS Code is opened on a workspace folder.'
    );
    return;
  }
  const noConfigFolders = folders.filter((folder) => {
    for (const configFile of configFiles) {
      if (fs.existsSync(path.join(Uri.parse(folder.uri).fsPath, configFile))) {
        return false;
      }
    }
    return true;
  });
  if (noConfigFolders.length === 0) {
    if (folders.length === 1) {
      Window.showInformationMessage('The workspace already contains an ESLint configuration file.');
    } else {
      Window.showInformationMessage('All workspace folders already contain an ESLint configuration file.');
    }
    return;
  }
  pickFolder(noConfigFolders, 'Select a workspace folder to generate a ESLint configuration for').then(
    async (folder) => {
      if (!folder) {
        return;
      }
      const folderRootPath = Uri.parse(folder.uri).fsPath;
      const terminal = await Workspace.createTerminal({
        name: `ESLint init`,
        cwd: folderRootPath,
      });
      const eslintCommand = await findEslint(folderRootPath);
      terminal.sendText(`${eslintCommand} --init`);
      terminal.show();
    }
  );
}

export const probeFailed: Set<string> = new Set();
export function computeValidate(textDocument: TextDocument): Validate {
  const config = Workspace.getConfiguration(linter, textDocument.uri);
  if (!config.get('enable', true)) {
    return Validate.off;
  }
  const languageId = textDocument.languageId;
  const validate = config.get<(ValidateItem | string)[]>('validate');
  if (Array.isArray(validate)) {
    for (const item of validate) {
      if (Is.string(item) && item === languageId) {
        return Validate.on;
      } else if (ValidateItem.is(item) && item.language === languageId) {
        return Validate.on;
      }
    }
  }
  const uri: string = textDocument.uri.toString();
  if (probeFailed.has(uri)) {
    return Validate.off;
  }
  const probe: string[] | undefined = config.get<string[]>('probe');
  if (Array.isArray(probe)) {
    for (const item of probe) {
      if (item === languageId) {
        return Validate.probe;
      }
    }
  }
  return Validate.off;
}

export const sessionState: Map<string, ExecutionParams> = new Map();
export const disabledLibraries: Set<string> = new Set();
export const resource2ResourceInfo: Map<string, ResourceInfo> = new Map();
export let globalStatus: Status | undefined;

export const libraryPath2ExecutionInfo: Map<string, ExecutionInfo> = new Map();
export const workspaceFolder2ExecutionInfos: Map<string, ExecutionInfo[]> = new Map();

function updateExecutionInfo(params: ExecutionParams, result: ConfirmExecutionResult): void {
  let value: ExecutionInfo | undefined = libraryPath2ExecutionInfo.get(params.libraryPath);
  if (value === undefined) {
    value = {
      params: { libraryPath: params.libraryPath, scope: params.scope },
      result: result,
      editorErrorUri: undefined,
      codeActionProvider: undefined,
      diagnostics: Languages.createDiagnosticCollection(),
    };
    libraryPath2ExecutionInfo.set(params.libraryPath, value);
  } else {
    value.result = result;
  }
}

export function updateStatusInfo(param: StatusParams): void {
  globalStatus = param.state;
  let info = resource2ResourceInfo.get(param.uri);
  if (info === undefined) {
    info = {
      executionInfo: undefined,
      status: param.state,
    };
    resource2ResourceInfo.set(param.uri, info);
  } else {
    info.status = param.state;
  }
}

export function getExecutionInfo(doc: Document | undefined, strict: boolean): ExecutionInfo | undefined {
  if (doc == undefined) {
    return undefined;
  }
  const info = resource2ResourceInfo.get(doc.uri);
  if (info !== undefined) {
    return info.executionInfo;
  }
  if (!strict) {
    const folder = Workspace.getWorkspaceFolder(doc.uri);
    if (folder) {
      const values = workspaceFolder2ExecutionInfos.get(folder.uri.toString());
      return values && values[0];
    }
  }
  return undefined;
}

function clearInfo(info: ExecutionInfo): void {
  info.diagnostics.clear();
  if (info.codeActionProvider !== undefined) {
    info.codeActionProvider.dispose();
  }
}

export function clearDiagnosticState(params: ExecutionParams): void {
  const info = libraryPath2ExecutionInfo.get(params.libraryPath);
  if (info === undefined) {
    return;
  }
  clearInfo(info);
}

function clearAllDiagnosticState(): void {
  // Make a copy
  for (const info of Array.from(libraryPath2ExecutionInfo.values())) {
    clearInfo(info);
  }
}

export async function askForLibraryConfirmation(
  client: LanguageClient | undefined,
  context: ExtensionContext,
  params: ExecutionParams,
  update: undefined | (() => void)
): Promise<void> {
  sessionState.set(params.libraryPath, params);

  // Reevaluate state and cancel since the information message is async
  const libraryUri = Uri.file(params.libraryPath);
  const folder = Workspace.getWorkspaceFolder(libraryUri.toString());

  interface ConfirmMessageItem extends MessageItem {
    value: ConfirmationSelection;
  }

  let message: string;
  if (folder) {
    let relativePath = libraryUri.toString().substr(folder.uri.toString().length + 1);
    const mainPath = '/lib/api.js';
    if (relativePath.endsWith(mainPath)) {
      relativePath = relativePath.substr(0, relativePath.length - mainPath.length);
    }
    message = `The ESLint extension will use '${relativePath}' for validation, which is installed locally in folder '${folder.name}'. Do you allow the execution of this ESLint version including all plugins and configuration files it will load on your behalf?\n\nPress 'Allow Everywhere' to remember the choice for all workspaces. Use 'Disable' to disable ESLint for this session.`;
  } else {
    message =
      params.scope === 'global'
        ? `The ESLint extension will use a globally installed ESLint library for validation. Do you allow the execution of this ESLint version including all plugins and configuration files it will load on your behalf?\n\nPress 'Always Allow' to remember the choice for all workspaces. Use 'Cancel' to disable ESLint for this session.`
        : `The ESLint extension will use a locally installed ESLint library for validation. Do you allow the execution of this ESLint version including all plugins and configuration files it will load on your behalf?\n\nPress 'Always Allow' to remember the choice for all workspaces. Use 'Cancel' to disable ESLint for this session.`;
  }

  const messageItems: ConfirmMessageItem[] = [
    { title: 'Allow Everywhere', value: ConfirmationSelection.alwaysAllow },
    { title: 'Allow', value: ConfirmationSelection.allow },
    { title: 'Deny', value: ConfirmationSelection.deny },
    { title: 'Disable', value: ConfirmationSelection.disable },
  ];
  const item = await Window.showInformationMessage<ConfirmMessageItem>(message, ...messageItems);

  // Dialog got canceled.
  if (item === undefined) {
    return;
  }

  if (item.value === ConfirmationSelection.disable) {
    disabledLibraries.add(params.libraryPath);
    updateExecutionInfo(params, ConfirmExecutionResult.disabled);
    clearDiagnosticState(params);
  } else {
    disabledLibraries.delete(params.libraryPath);
    if (item.value === ConfirmationSelection.allow || item.value === ConfirmationSelection.deny) {
      const value = item.value === ConfirmationSelection.allow ? true : false;
      eslintExecutionState.libs[params.libraryPath] = value;
      context.globalState.update(eslintExecutionKey, eslintExecutionState);
      updateExecutionInfo(params, value ? ConfirmExecutionResult.approved : ConfirmExecutionResult.denied);
      clearDiagnosticState(params);
    } else if (item.value === ConfirmationSelection.alwaysAllow) {
      eslintAlwaysAllowExecutionState = true;
      context.globalState.update(eslintAlwaysAllowExecutionKey, eslintAlwaysAllowExecutionState);
      updateExecutionInfo(params, ConfirmExecutionResult.approved);
      clearAllDiagnosticState();
    }
  }

  update && update();
  // @ts-ignore
  client && client.sendNotification(DidChangeConfigurationNotification.type, { settings: {} });
}

export async function resetLibraryConfirmations(
  client: LanguageClient | undefined,
  context: ExtensionContext,
  update: undefined | (() => void)
): Promise<void> {
  interface ESLintQuickPickItem extends QuickPickItem {
    kind: 'all' | 'allConfirmed' | 'allRejected' | 'session' | 'alwaysAllow';
  }
  const items: ESLintQuickPickItem[] = [
    { label: 'Reset ESLint library decisions for this workspace', kind: 'session' },
    { label: 'Reset all ESLint library decisions', kind: 'all' },
  ];
  if (eslintAlwaysAllowExecutionState) {
    items.splice(1, 0, { label: 'Reset Always Allow all ESlint libraries decision', kind: 'alwaysAllow' });
  }
  const selectedIdx = await Window.showQuickpick(
    items.map((o) => o.label),
    'Clear library confirmations'
  );
  if (selectedIdx == -1) {
    return;
  }
  const selected = items[selectedIdx];
  switch (selected.kind) {
    case 'all':
      eslintExecutionState.libs = {};
      eslintAlwaysAllowExecutionState = false;
      break;
    case 'alwaysAllow':
      eslintAlwaysAllowExecutionState = false;
      break;
    case 'session':
      if (sessionState.size === 1) {
        const param = sessionState.values().next().value;
        await askForLibraryConfirmation(client, context, param, update);
        return;
      } else {
        for (const lib of sessionState.keys()) {
          delete eslintExecutionState.libs[lib];
        }
      }
      break;
  }
  context.globalState.update(eslintExecutionKey, eslintExecutionState);
  context.globalState.update(eslintAlwaysAllowExecutionKey, eslintAlwaysAllowExecutionState);
  disabledLibraries.clear();
  libraryPath2ExecutionInfo.clear();
  resource2ResourceInfo.clear();
  workspaceFolder2ExecutionInfos.clear();
  update && update();
  // @ts-ignore
  client && client.sendNotification(DidChangeConfigurationNotification.type, { settings: {} });
}

export function realActivate(context: ExtensionContext): void {
  const statusBarItem = Window.createStatusBarItem(0);
  context.subscriptions.push(statusBarItem);
  let serverRunning: boolean | undefined;

  const starting = 'ESLint server is starting.';
  const running = 'ESLint server is running.';
  const stopped = 'ESLint server stopped.';
  statusBarItem.text = 'ESLint';

  function updateStatusBar(status: Status, isValidated: boolean) {
    let text = 'ESLint';
    switch (status) {
      case Status.ok:
        text = '';
        break;
      case Status.warn:
        text = 'Eslint warning';
        break;
      case Status.error:
        text = 'Eslint error';
        break;
      case Status.executionDenied:
        text = 'Eslint denied';
        break;
      case Status.executionDisabled:
        text = 'Eslint disabled';
        break;
      case Status.confirmationPending:
        text = 'ESLint not approved or denied yet.';
        break;
      default:
        text = '';
    }
    statusBarItem.text = serverRunning === undefined ? starting : text;
    const alwaysShow = Workspace.getConfiguration(linter).get('alwaysShowStatus', false);
    if (
      alwaysShow ||
      eslintAlwaysAllowExecutionState === true ||
      status !== Status.ok ||
      (status === Status.ok && isValidated)
    ) {
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  }

  const flaggedLanguages = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);
  async function updateStatusBarAndDiagnostics(): Promise<void> {
    const doc = await Workspace.document;

    function clearLastExecutionInfo(): void {
      if (lastExecutionInfo === undefined) {
        return;
      }
      if (lastExecutionInfo.codeActionProvider !== undefined) {
        lastExecutionInfo.codeActionProvider.dispose();
        lastExecutionInfo.codeActionProvider = undefined;
      }
      if (lastExecutionInfo.editorErrorUri !== undefined) {
        lastExecutionInfo.diagnostics.delete(lastExecutionInfo.editorErrorUri.toString());
        lastExecutionInfo.editorErrorUri = undefined;
      }
      lastExecutionInfo = undefined;
    }

    function handleEditor(doc: Document): void {
      const uri = doc.uri;

      const resourceInfo = resource2ResourceInfo.get(uri);
      if (resourceInfo === undefined) {
        return;
      }
      const info = resourceInfo.executionInfo;
      if (info === undefined) {
        return;
      }

      if (
        info.result === ConfirmExecutionResult.confirmationPending &&
        info.editorErrorUri?.toString() !== uri.toString()
      ) {
        const range = doc.getWordRangeAtPosition(Position.create(0, 0)) ?? Range.create(0, 0, 0, 0);
        const diagnostic = Diagnostic.create(
          range,
          'ESLint is disabled since its execution has not been approved or denied yet. Use :CocCommand eslint.showOutputChannel to open the approval dialog.',
          VDiagnosticSeverity.Warning
        );
        diagnostic.source = linter;
        const errorUri = doc.uri;

        info.diagnostics.set(errorUri, [diagnostic]);
        if (info.editorErrorUri !== undefined) {
          info.diagnostics.delete(info.editorErrorUri.toString());
        }
        info.editorErrorUri = Uri.parse(errorUri);
        if (info.codeActionProvider !== undefined) {
          info.codeActionProvider.dispose();
        }
        info.codeActionProvider = Languages.registerCodeActionProvider(
          [{ pattern: Uri.parse(errorUri).fsPath }],
          {
            provideCodeActions: (_document, _range, context) => {
              for (const diag of context.diagnostics) {
                if (diag === diagnostic) {
                  const result: CodeAction = {
                    title: 'ESLint: Manage Library Execution',
                    kind: CodeActionKind.QuickFix,
                  };
                  result.isPreferred = true;
                  result.command = {
                    title: 'Manage Library Execution',
                    command: `${linter}.manageLibraryExecution`,
                    arguments: [info.params],
                  };
                  return [result];
                }
              }
              return [];
            },
          },
          'eslint-library'
        );
      }

      lastExecutionInfo = info;
    }

    function findApplicableStatus(editor: Document | undefined): [Status, boolean] {
      let candidates: IterableIterator<ExecutionInfo> | ExecutionInfo[] | undefined;
      if (editor !== undefined) {
        const resourceInfo = resource2ResourceInfo.get(editor.uri);
        if (resourceInfo !== undefined) {
          return [resourceInfo.status, true];
        }
        const workspaceFolder = Workspace.getWorkspaceFolder(editor.uri);
        if (workspaceFolder) {
          candidates = workspaceFolder2ExecutionInfos.get(workspaceFolder.uri.toString());
        }
      }
      if (candidates === undefined) {
        candidates = libraryPath2ExecutionInfo.values();
      }
      let result: ConfirmExecutionResult | undefined;
      for (const info of candidates) {
        if (result === undefined) {
          result = info.result;
        } else {
          if (info.result === ConfirmExecutionResult.confirmationPending) {
            result = info.result;
            break;
          } else if (info.result === ConfirmExecutionResult.denied || info.result === ConfirmExecutionResult.disabled) {
            result = info.result;
          }
        }
      }
      return [result !== undefined ? ConfirmExecutionResult.toStatus(result) : Status.ok, false];
    }

    const executionInfo = getExecutionInfo(doc, true);
    if (lastExecutionInfo !== executionInfo) {
      clearLastExecutionInfo();
    }

    if (doc && doc.attached && flaggedLanguages.has(doc.filetype)) {
      handleEditor(doc);
    } else {
      clearLastExecutionInfo();
    }

    const [status, isValidated] = findApplicableStatus(doc);
    updateStatusBar(status, isValidated);
  }

  const serverModule = context.asAbsolutePath('lib/server.js');
  // Uri.joinPath(context.extensionUri, 'server', 'out', 'eslintServer.js').fsPath
  const eslintConfig = Workspace.getConfiguration(linter);
  const runtime = eslintConfig.get('runtime', undefined);
  const debug = eslintConfig.get('debug');
  const argv = eslintConfig.get<string[]>('execArgv', []);
  const nodeEnv = eslintConfig.get('nodeEnv', null);

  let env: { [key: string]: string | number | boolean } | undefined;
  if (debug) {
    env = env || {};
    env.DEBUG = 'eslint:*,-eslint:code-path';
  }
  if (nodeEnv) {
    env = env || {};
    env.NODE_ENV = nodeEnv;
  }
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
      runtime,
      options: { cwd: Workspace.cwd, env, execArgv: argv },
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      runtime,
      options: { execArgv: argv.concat(['--nolazy', '--inspect=6011']), cwd: process.cwd(), env },
    },
  };

  let defaultErrorHandler: ErrorHandler;
  let serverCalledProcessExit = false;

  const packageJsonFilter: DocumentFilter = { scheme: 'file', pattern: '**/package.json' };
  const configFileFilter: DocumentFilter = { scheme: 'file', pattern: '**/.eslintr{c.js,c.yaml,c.yml,c,c.json}' };
  const syncedDocuments: Map<string, TextDocument> = new Map<string, TextDocument>();
  const confirmationSemaphore: Semaphore<ConfirmExecutionResult> = new Semaphore<ConfirmExecutionResult>(1);
  const supportedQuickFixKinds: Set<string> = new Set([
    CodeActionKind.Source,
    CodeActionKind.SourceFixAll,
    `${CodeActionKind.SourceFixAll}.eslint`,
    CodeActionKind.QuickFix,
  ]);
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file' }, { scheme: 'untitled' }],
    diagnosticCollectionName: linter,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    initializationOptions: {},
    progressOnInitialization: true,
    synchronize: {
      // configurationSection: 'eslint',
      fileEvents: [
        Workspace.createFileSystemWatcher('**/.eslintr{c.js,c.yaml,c.yml,c,c.json}'),
        Workspace.createFileSystemWatcher('**/.eslintignore'),
        Workspace.createFileSystemWatcher('**/package.json'),
      ],
    },
    initializationFailedHandler: (error) => {
      client.error('Server initialization failed.', error);
      client.outputChannel.show(true);
      return false;
    },
    errorHandler: {
      error: (error, message, count): ErrorAction => {
        return defaultErrorHandler.error(error, message, count);
      },
      closed: (): CloseAction => {
        if (serverCalledProcessExit) {
          return CloseAction.DoNotRestart;
        }
        return defaultErrorHandler.closed();
      },
    },
    middleware: {
      didOpen: (document, next) => {
        if (
          Workspace.match([packageJsonFilter], document) ||
          Workspace.match([configFileFilter], document) ||
          computeValidate(document) !== Validate.off
        ) {
          next(document);
          syncedDocuments.set(document.uri, document);
          return;
        }
      },
      didChange: (event, next) => {
        if (syncedDocuments.has(event.textDocument.uri)) {
          next(event);
        }
      },
      willSave: (event, next) => {
        if (syncedDocuments.has(event.document.uri)) {
          next(event);
        }
      },
      willSaveWaitUntil: (event, next) => {
        if (syncedDocuments.has(event.document.uri)) {
          return next(event);
        } else {
          return Promise.resolve([]);
        }
      },
      didSave: (document, next) => {
        if (syncedDocuments.has(document.uri)) {
          next(document);
        }
      },
      didClose: (document, next) => {
        const uri = document.uri;
        if (syncedDocuments.has(uri)) {
          syncedDocuments.delete(uri);
          next(document);
        }
      },
      provideCodeActions: (document, range, context, token, next): ProviderResult<(Command | CodeAction)[]> => {
        if (!syncedDocuments.has(document.uri.toString())) {
          return [];
        }
        if (context.only !== undefined && !supportedQuickFixKinds.has(context.only[0])) {
          return [];
        }
        if (context.only === undefined && (!context.diagnostics || context.diagnostics.length === 0)) {
          return [];
        }
        const eslintDiagnostics: Diagnostic[] = [];
        for (const diagnostic of context.diagnostics) {
          if (diagnostic.source === linter) {
            eslintDiagnostics.push(diagnostic);
          }
        }
        if (context.only === undefined && eslintDiagnostics.length === 0) {
          return [];
        }
        const newContext: CodeActionContext = Object.assign({}, context, {
          diagnostics: eslintDiagnostics,
        } as CodeActionContext);
        return next(document, range, newContext, token);
      },
      workspace: {
        didChangeWatchedFile: (event, next) => {
          probeFailed.clear();
          next(event);
        },
        didChangeConfiguration: (sections, next) => {
          next(sections);
        },
        configuration: async (params, _token, _next): Promise<any[]> => {
          if (params.items === undefined) {
            return [];
          }
          const result: (ConfigurationSettings | null)[] = [];
          for (const item of params.items) {
            if (item.section || !item.scopeUri) {
              result.push(null);
              continue;
            }
            const resource = item.scopeUri;
            const config = Workspace.getConfiguration(linter, resource);
            const workspaceFolder = Workspace.getWorkspaceFolder(resource);
            const settings: ConfigurationSettings = {
              validate: Validate.off,
              packageManager: config.get('packageManager', 'npm'),
              codeActionOnSave: {
                enable: false,
                mode: CodeActionsOnSaveMode.all,
              },
              format: false,
              quiet: config.get('quiet', false),
              onIgnoredFiles: ESLintSeverity.from(config.get<string>('onIgnoredFiles', ESLintSeverity.off)),
              options: config.get('options', {}),
              run: config.get('run', 'onType'),
              nodePath: config.get('nodePath', null),
              workingDirectory: undefined,
              workspaceFolder: undefined,
              codeAction: {
                disableRuleComment: config.get('codeAction.disableRuleComment', {
                  enable: true,
                  location: 'separateLine' as const,
                }),
                showDocumentation: config.get('codeAction.showDocumentation', { enable: true }),
              },
            };
            const document: TextDocument | undefined = syncedDocuments.get(item.scopeUri);
            if (document === undefined) {
              result.push(settings);
              continue;
            }
            if (config.get('enabled', true)) {
              settings.validate = computeValidate(document);
            }
            if (settings.validate !== Validate.off) {
              settings.format = !!config.get('format.enable', false);
              settings.codeActionOnSave.enable = !!config.get('autoFixOnSave', false); //readCodeActionsOnSaveSetting(document)
              settings.codeActionOnSave.mode = CodeActionsOnSaveMode.from(
                config.get('codeActionsOnSave.mode', CodeActionsOnSaveMode.all)
              );
            }
            if (workspaceFolder) {
              settings.workspaceFolder = {
                name: workspaceFolder.name,
                uri: workspaceFolder.uri,
              };
            }
            const workingDirectories = config.get<
              (string | LegacyDirectoryItem | DirectoryItem | PatternItem | ModeItem)[] | undefined
            >('workingDirectories', undefined);
            if (Array.isArray(workingDirectories)) {
              let workingDirectory: ModeItem | DirectoryItem | undefined = undefined;
              const workspaceFolderPath =
                workspaceFolder && Uri.parse(workspaceFolder.uri).scheme === 'file'
                  ? Uri.parse(workspaceFolder.uri).fsPath
                  : undefined;
              for (const entry of workingDirectories) {
                let directory: string | undefined;
                let pattern: string | undefined;
                let noCWD = false;
                if (Is.string(entry)) {
                  directory = entry;
                } else if (LegacyDirectoryItem.is(entry)) {
                  directory = entry.directory;
                  noCWD = !entry.changeProcessCWD;
                } else if (DirectoryItem.is(entry)) {
                  directory = entry.directory;
                  if (entry['!cwd'] !== undefined) {
                    noCWD = entry['!cwd'];
                  }
                } else if (PatternItem.is(entry)) {
                  pattern = entry.pattern;
                  if (entry['!cwd'] !== undefined) {
                    noCWD = entry['!cwd'];
                  }
                } else if (ModeItem.is(entry)) {
                  workingDirectory = entry;
                  continue;
                }

                let itemValue: string | undefined;
                if (directory !== undefined || pattern !== undefined) {
                  const uri = Uri.parse(document.uri);
                  const filePath = uri.scheme === 'file' ? uri.fsPath : undefined;
                  if (filePath !== undefined) {
                    if (directory !== undefined) {
                      directory = toOSPath(directory);
                      if (!path.isAbsolute(directory) && workspaceFolderPath !== undefined) {
                        directory = path.join(workspaceFolderPath, directory);
                      }
                      if (directory.charAt(directory.length - 1) !== path.sep) {
                        directory = directory + path.sep;
                      }
                      if (filePath.startsWith(directory)) {
                        itemValue = directory;
                      }
                    } else if (pattern !== undefined && pattern.length > 0) {
                      if (!path.posix.isAbsolute(pattern) && workspaceFolderPath !== undefined) {
                        pattern = path.posix.join(toPosixPath(workspaceFolderPath), pattern);
                      }
                      if (pattern.charAt(pattern.length - 1) !== path.posix.sep) {
                        pattern = pattern + path.posix.sep;
                      }
                      const regExp: RegExp | undefined = convert2RegExp(pattern);
                      if (regExp !== undefined) {
                        const match = regExp.exec(filePath);
                        if (match !== null && match.length > 0) {
                          itemValue = match[0];
                        }
                      }
                    }
                  }
                }
                if (itemValue !== undefined) {
                  if (workingDirectory === undefined || ModeItem.is(workingDirectory)) {
                    workingDirectory = { directory: itemValue, '!cwd': noCWD };
                  } else {
                    if (workingDirectory.directory.length < itemValue.length) {
                      workingDirectory.directory = itemValue;
                      workingDirectory['!cwd'] = noCWD;
                    }
                  }
                }
              }
              settings.workingDirectory = workingDirectory;
            }
            result.push(settings);
          }
          return result;
        },
      },
    },
  };

  let client: LanguageClient;
  try {
    client = new LanguageClient('ESLint', serverOptions, clientOptions);
  } catch (err) {
    Window.showErrorMessage(`The ESLint extension couldn't be started. See the ESLint output channel for details.`);
    return;
  }

  Workspace.registerAutocmd({
    request: true,
    event: 'BufWritePre',
    arglist: [`+expand('<abuf>')`],
    callback: async (bufnr: number) => {
      const doc = Workspace.getDocument(bufnr);
      if (!doc || !doc.attached) return;
      if (computeValidate(doc.textDocument) == Validate.off) return;
      const config = Workspace.getConfiguration(linter, doc.uri);
      if (config.get('autoFixOnSave', false)) {
        const params: CodeActionParams = {
          textDocument: {
            uri: doc.uri,
          },
          range: Range.create(0, 0, doc.textDocument.lineCount, 0),
          context: {
            only: [`${CodeActionKind.SourceFixAll}.${linter}`],
            diagnostics: [],
          },
        };
        // @ts-ignore
        const res = await Promise.resolve(client.sendRequest(CodeActionRequest.type, params));
        if (res && Array.isArray(res)) {
          if (res[0].edit && CodeAction.is(res[0])) {
            await Workspace.applyEdit(res[0].edit);
          }
        }
      }
    },
  });
  // client.registerProposedFeatures()

  Workspace.onDidChangeConfiguration(() => {
    probeFailed.clear();
    for (const textDocument of syncedDocuments.values()) {
      if (computeValidate(textDocument) === Validate.off) {
        try {
          const provider = (client as any)
            .getFeature(DidCloseTextDocumentNotification.method)
            .getProvider(textDocument);
          provider?.send(textDocument);
        } catch (err) {
          // A feature currently throws if no provider can be found. So for now we catch the exception.
        }
      }
    }
    for (const textDocument of Workspace.textDocuments) {
      if (!syncedDocuments.has(textDocument.uri.toString()) && computeValidate(textDocument) !== Validate.off) {
        try {
          const provider = (client as any).getFeature(DidOpenTextDocumentNotification.method).getProvider(textDocument);
          provider?.send(textDocument);
        } catch (err) {
          // A feature currently throws if no provider can be found. So for now we catch the exception.
        }
      }
    }
  });

  defaultErrorHandler = (client as any).createDefaultErrorHandler();
  client.onDidChangeState((event) => {
    if (event.newState === ClientState.Starting) {
      client.info('ESLint server is starting');
      serverRunning = undefined;
    } else if (event.newState === ClientState.Running) {
      client.info(running);
      serverRunning = true;
    } else {
      client.info(stopped);
      serverRunning = false;
    }
    updateStatusBar(globalStatus ?? serverRunning === false ? Status.error : Status.ok, true);
  });
  client.onReady().then(() => {
    client.onNotification(ShowOutputChannel.type, () => {
      client.outputChannel.show();
    });

    client.onNotification(StatusNotification.type, (params) => {
      updateStatusInfo(params);
      updateStatusBarAndDiagnostics();
    });

    client.onNotification(exitCalled, (params) => {
      serverCalledProcessExit = true;
      client.error(
        `Server process exited with code ${params[0]}. This usually indicates a misconfigured ESLint setup.`,
        params[1]
      );
      Window.showErrorMessage(`ESLint server shut down itself. See 'ESLint' output channel for details.`, {
        title: 'Open Output',
        id: 1,
      }).then((value) => {
        if (value !== undefined && value.id === 1) {
          client.outputChannel.show();
        }
      });
    });

    client.onRequest(NoConfigRequest.type, (params) => {
      const uri = Uri.parse(params.document.uri);
      const workspaceFolder = Workspace.getWorkspaceFolder(params.document.uri);
      const fileLocation = uri.fsPath;
      if (workspaceFolder) {
        client.warn(
          [
            '',
            `No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
            `File will not be validated. Consider running 'eslint --init' in the workspace folder ${workspaceFolder.name}`,
            `Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`,
          ].join('\n')
        );
      } else {
        client.warn(
          [
            '',
            `No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
            `File will not be validated. Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`,
          ].join('\n')
        );
      }

      let resourceInfo: ResourceInfo | undefined = resource2ResourceInfo.get(params.document.uri);
      if (resourceInfo === undefined) {
        resourceInfo = {
          status: Status.warn,
          executionInfo: undefined,
        };
        resource2ResourceInfo.set(params.document.uri, resourceInfo);
      } else {
        resourceInfo.status = Status.warn;
      }
      updateStatusBarAndDiagnostics();
      return {};
    });

    client.onRequest(NoESLintLibraryRequest.type, (params) => {
      const key = 'noESLintMessageShown';
      const state = context.globalState.get<NoESLintState>(key, {});

      const uri: Uri = Uri.parse(params.source.uri);
      const workspaceFolder = Workspace.getWorkspaceFolder(uri.toString());
      const packageManager = Workspace.getConfiguration(linter, uri.toString()).get('packageManager', 'npm');
      const localInstall = {
        npm: 'npm install xo',
        pnpm: 'pnpm install xo',
        yarn: 'yarn add xo',
      };
      const globalInstall = {
        npm: 'npm install -g xo',
        pnpm: 'pnpm install -g xo',
        yarn: 'yarn global add xo',
      };
      const isPackageManagerNpm = packageManager === 'npm';
      interface ButtonItem extends MessageItem {
        id: number;
      }
      const outputItem: ButtonItem = {
        title: 'Go to output',
        id: 1,
      };
      if (workspaceFolder) {
        client.info(
          [
            '',
            `Failed to load the ESLint library for the document ${uri.fsPath}`,
            '',
            `To use ESLint please install eslint by running ${localInstall[packageManager]} in the workspace folder ${workspaceFolder.name}`,
            `or globally using '${globalInstall[packageManager]}'. You need to reopen the workspace after installing eslint.`,
            '',
            isPackageManagerNpm
              ? 'If you are using yarn or pnpm instead of npm set the setting `eslint.packageManager` to either `yarn` or `pnpm`'
              : null,
            `Alternatively you can disable ESLint for the workspace folder ${workspaceFolder.name} by executing the 'Disable ESLint' command.`,
          ]
            .filter((str) => str !== null)
            .join('\n')
        );

        if (state.workspaces === undefined) {
          state.workspaces = {};
        }
        if (!state.workspaces[workspaceFolder.uri.toString()]) {
          state.workspaces[workspaceFolder.uri.toString()] = true;
          context.globalState.update(key, state);
          Window.showInformationMessage(
            `Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`,
            outputItem
          ).then((item) => {
            if (item && item.id === 1) {
              client.outputChannel.show(true);
            }
          });
        }
      } else {
        client.info(
          [
            `Failed to load the ESLint library for the document ${uri.fsPath}`,
            `To use ESLint for single JavaScript file install eslint globally using '${globalInstall[packageManager]}'.`,
            isPackageManagerNpm
              ? 'If you are using yarn or pnpm instead of npm set the setting `eslint.packageManager` to either `yarn` or `pnpm`'
              : null,
            'You need to reopen VS Code after installing eslint.',
          ]
            .filter((str) => str !== null)
            .join('\n')
        );

        if (!state.global) {
          state.global = true;
          context.globalState.update(key, state);
          Window.showInformationMessage(
            `Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`,
            outputItem
          ).then((item) => {
            if (item && item.id === 1) {
              client.outputChannel.show(true);
            }
          });
        }
      }
      return {};
    });

    client.onRequest(OpenESLintDocRequest.type, (params) => {
      Commands.executeCommand('vscode.open', Uri.parse(params.url));
      return {};
    });

    client.onRequest(ProbeFailedRequest.type, (params) => {
      probeFailed.add(params.textDocument.uri);
      const closeFeature = (client as any).getFeature(DidCloseTextDocumentNotification.method);
      for (const document of Workspace.textDocuments) {
        if (document.uri.toString() === params.textDocument.uri) {
          closeFeature.getProvider(document)?.send(document);
        }
      }
    });

    client.onRequest(ConfirmExecution.type, async (params): Promise<ConfirmExecutionResult> => {
      return confirmationSemaphore.lock(async () => {
        try {
          sessionState.set(params.libraryPath, params);
          let result: ConfirmExecutionResult | undefined;
          if (disabledLibraries.has(params.libraryPath)) {
            result = ConfirmExecutionResult.disabled;
          } else {
            const state = eslintExecutionState.libs[params.libraryPath];
            if (state === true || state === false) {
              clearDiagnosticState(params);
              result = state ? ConfirmExecutionResult.approved : ConfirmExecutionResult.denied;
            } else if (eslintAlwaysAllowExecutionState === true) {
              clearDiagnosticState(params);
              result = ConfirmExecutionResult.approved;
            }
          }
          result = result ?? ConfirmExecutionResult.confirmationPending;
          let executionInfo: ExecutionInfo | undefined = libraryPath2ExecutionInfo.get(params.libraryPath);
          if (executionInfo === undefined) {
            executionInfo = {
              params: params,
              result: result,
              codeActionProvider: undefined,
              diagnostics: Languages.createDiagnosticCollection(),
              editorErrorUri: undefined,
            };
            libraryPath2ExecutionInfo.set(params.libraryPath, executionInfo);
            const workspaceFolder = Workspace.getWorkspaceFolder(params.uri);
            if (workspaceFolder) {
              const key = workspaceFolder.uri.toString();
              let infos = workspaceFolder2ExecutionInfos.get(key);
              if (infos === undefined) {
                infos = [];
                workspaceFolder2ExecutionInfos.set(key, infos);
              }
              infos.push(executionInfo);
            }
          } else {
            executionInfo.result = result;
          }
          let resourceInfo = resource2ResourceInfo.get(params.uri);
          if (resourceInfo === undefined) {
            resourceInfo = {
              status: ConfirmExecutionResult.toStatus(result),
              executionInfo: executionInfo,
            };
            resource2ResourceInfo.set(params.uri, resourceInfo);
          } else {
            resourceInfo.status = ConfirmExecutionResult.toStatus(result);
          }
          updateStatusBarAndDiagnostics();
          return result;
        } catch (err) {
          return ConfirmExecutionResult.denied;
        }
      });
    });
  });

  if (onActivateCommands) {
    onActivateCommands.forEach((command) => command.dispose());
    onActivateCommands = undefined;
  }

  context.subscriptions.push(
    client.start(),
    events.on('BufEnter', () => {
      updateStatusBarAndDiagnostics();
    }),
    Workspace.registerTextDocumentContentProvider(`${linter}-error`, {
      provideTextDocumentContent: () => {
        return [
          'ESLint is disabled since its execution has not been approved or rejected yet.',
          '',
          'When validating a file using ESLint, the ESLint NPM library will load customization files and code from your workspace',
          'and will execute it. If you do not trust the content in your workspace you should answer accordingly on the corresponding',
          'approval dialog.',
        ].join('\n');
      },
    }),
    Workspace.onDidCloseTextDocument((document) => {
      const uri = document.uri.toString();
      resource2ResourceInfo.delete(uri);
    }),
    Commands.registerCommand(`${linter}.executeAutofix`, async () => {
      const doc = await Workspace.document;
      if (!doc || !doc.attached) {
        return;
      }
      doc.forceSync();
      const textDocument: VersionedTextDocumentIdentifier = {
        uri: doc.uri,
        version: doc.version,
      };
      const params: ExecuteCommandParams = {
        command: `${linter}.applyAllFixes`,
        arguments: [textDocument],
      };
      await client.onReady();
      // @ts-ignore
      client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, () => {
        Window.showErrorMessage(
          'Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.'
        );
      });
    }),
    Commands.registerCommand(`${linter}.showOutputChannel`, async () => {
      const doc = await Workspace.document;
      const executionInfo = getExecutionInfo(doc, false);
      if (
        executionInfo !== undefined &&
        (executionInfo.result === ConfirmExecutionResult.confirmationPending ||
          executionInfo.result === ConfirmExecutionResult.disabled)
      ) {
        await askForLibraryConfirmation(client, context, executionInfo.params, updateStatusBarAndDiagnostics);
        return;
      }

      if (globalStatus === Status.ok || globalStatus === Status.warn || globalStatus === Status.error) {
        client.outputChannel.show();
        return;
      }

      if (globalStatus === Status.executionDenied) {
        await resetLibraryConfirmations(client, context, updateStatusBarAndDiagnostics);
        return;
      }

      let candidate: string | undefined;
      let toRemove: Set<string> | Map<string, boolean> | undefined;
      if (globalStatus === Status.confirmationPending) {
        if (libraryPath2ExecutionInfo.size === 1) {
          candidate = libraryPath2ExecutionInfo.keys().next().value;
        }
      }
      if (globalStatus === Status.executionDisabled) {
        if (disabledLibraries.size === 1) {
          candidate = disabledLibraries.keys().next().value;
          toRemove = disabledLibraries;
        }
      }

      if (candidate !== undefined) {
        if (sessionState.has(candidate)) {
          if (toRemove !== undefined) {
            toRemove.delete(candidate);
          }
          await askForLibraryConfirmation(client, context, sessionState.get(candidate)!, updateStatusBarAndDiagnostics);
          return;
        }
      }
      client.outputChannel.show();
    }),
    Commands.registerCommand(`${linter}.resetLibraryExecution`, () => {
      resetLibraryConfirmations(client, context, updateStatusBarAndDiagnostics);
    }),
    Commands.registerCommand(`${linter}.manageLibraryExecution`, async (params: ConfirmExecutionParams | undefined) => {
      if (params !== undefined) {
        await askForLibraryConfirmation(client, context, params, updateStatusBarAndDiagnostics);
      } else {
        const doc = await Workspace.document;
        const info = getExecutionInfo(doc, false);
        if (info !== undefined) {
          await askForLibraryConfirmation(client, context, info.params, updateStatusBarAndDiagnostics);
        } else {
          Window.showInformationMessage(
            doc && doc.attached
              ? 'No ESLint library execution information found for current buffer.'
              : 'No ESLint library execution information found.'
          );
        }
      }
    })
  );
}
