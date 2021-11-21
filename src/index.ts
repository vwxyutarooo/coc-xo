import { commands, Disposable, ExtensionContext, TextDocument, window, workspace } from 'coc.nvim';
import { linter, eslintAlwaysAllowExecutionKey, eslintExecutionKey } from './constants';
import {
  computeValidate,
  createDefaultConfiguration,
  onActivateCommands,
  realActivate,
  resetLibraryConfirmations,
  setEslintAlwaysAllowExecutionState,
  setEslintExecutionState,
  setOnActivateCommands,
} from './client/eslintClient';
import EslintTask from './client/task';
import { ESLintExecutionState, Validate } from './client/types';

export function activate(context: ExtensionContext) {
  setEslintExecutionState(context.globalState.get<ESLintExecutionState>(eslintExecutionKey, { libs: {} }));
  setEslintAlwaysAllowExecutionState(context.globalState.get<boolean>(eslintAlwaysAllowExecutionKey, false));

  function didOpenTextDocument(textDocument: TextDocument) {
    if (activated) {
      return;
    }
    if (computeValidate(textDocument) !== Validate.off) {
      openListener.dispose();
      configurationListener.dispose();
      activated = true;
      realActivate(context);
    }
  }

  function configurationChanged() {
    if (activated) {
      return;
    }
    for (const textDocument of workspace.textDocuments) {
      if (computeValidate(textDocument) !== Validate.off) {
        openListener.dispose();
        configurationListener.dispose();
        activated = true;
        realActivate(context);
        return;
      }
    }
  }

  let activated = false;
  const openListener: Disposable = workspace.onDidOpenTextDocument(didOpenTextDocument);
  const configurationListener: Disposable = workspace.onDidChangeConfiguration(configurationChanged);

  const notValidating = async () => {
    const bufnr = await workspace.nvim.call('bufnr', ['%']);
    const doc = workspace.getDocument(bufnr);
    const enabled = workspace.getConfiguration(linter, doc ? doc.uri : undefined).get('enable', true);
    if (!enabled) {
      window.showInformationMessage(
        `${linter.toUpperCase()} is not running because the deprecated setting '${linter}.enable' is set to false. Remove the setting and use the extension disablement feature.`
      );
    } else {
      window.showInformationMessage(
        `${linter.toUpperCase()} is not running. By default only TypeScript and JavaScript files are validated. If you want to validate other file types please specify them in the '${linter}.probe' setting.`
      );
    }
  };
  setOnActivateCommands([
    commands.registerCommand(`${linter}.executeAutofix`, notValidating),
    commands.registerCommand(`${linter}.showOutputChannel`, notValidating),
    commands.registerCommand(`${linter}.manageLibraryExecution`, notValidating),
    commands.registerCommand(`${linter}.resetLibraryExecution`, () => {
      resetLibraryConfirmations(undefined, context, undefined);
    }),
  ]);

  context.subscriptions.push(commands.registerCommand(`${linter}.createConfig`, createDefaultConfiguration));
  context.subscriptions.push(new EslintTask());
  configurationChanged();
}

export function deactivate() {
  if (onActivateCommands) {
    onActivateCommands.forEach((command) => command.dispose());
  }
}
