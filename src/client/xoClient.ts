import { ExtensionContext, LanguageClient, TransportKind, window, workspace } from 'coc.nvim';
import {
  VersionedTextDocumentIdentifier,
  ExecuteCommandParams,
  ExecuteCommandRequest,
} from 'vscode-languageserver-protocol';
import isSANB from 'is-string-and-not-blank';
import { linter } from '../constants';

let client: LanguageClient | undefined;

export function getClient() {
  return client;
}
export function initClient(context: ExtensionContext) {
  if (client) {
    return client;
  }

  const cwd = process.cwd();

  // The server is implemented in node
  const serverModule = context.asAbsolutePath('lib/server.js');
  const debugOptions = {
    execArgv: ['--nolazy', '--inspect=6004'],
    cwd,
  };

  const xoOptions = workspace.getConfiguration(linter);
  const runtime = isSANB(xoOptions.get('runtime')) && xoOptions.get('runtime');

  const serverOptions = {
    run: {
      module: serverModule,
      runtime,
      transport: TransportKind.ipc,
      options: { cwd },
    },
    debug: {
      module: serverModule,
      runtime,
      transport: TransportKind.ipc,
      options: debugOptions,
    },
  };
  const clientOptions = {
    documentSelector: [
      { language: 'javascript', scheme: 'file' },
      { language: 'javascript', scheme: 'untitled' },
      { language: 'javascriptreact', scheme: 'file' },
      { language: 'javascriptreact', scheme: 'untitled' },
      { language: 'typescript', scheme: 'file' },
      { language: 'typescript', scheme: 'untitled' },
      { language: 'typescriptreact', scheme: 'file' },
      { language: 'typescriptreact', scheme: 'untitled' },
    ],
    synchronize: {
      configurationSection: linter,
      fileEvents: [
        // we relint all open textDocuments whenever a config changes
        // that may possibly affect the options xo should be using
        workspace.createFileSystemWatcher('**/.eslintignore'),
        workspace.createFileSystemWatcher('**/.xo-confi{g.cjs,g.json,g.js,g}'),
        workspace.createFileSystemWatcher('**/xo.confi{g.cjs,g.js,g}'),
        workspace.createFileSystemWatcher('**/package.json'),
      ],
    },
  };

  client = new LanguageClient(linter, serverOptions, clientOptions);
  return client;
}

export async function executeAutofix() {
  const doc = await workspace.document;
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
  await client?.onReady();
  // @ts-ignore
  client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, () => {
    window.showErrorMessage(
      'Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.'
    );
  });
}
