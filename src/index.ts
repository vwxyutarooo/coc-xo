import { commands, ExtensionContext, SettingMonitor, window } from 'coc.nvim';
import { initClient, getClient, executeAutofix } from './client/xoClient';
import { linter } from './constants';

export async function activate(context: ExtensionContext): Promise<void> {
  const client = initClient(context);

  context.subscriptions.push(
    new SettingMonitor(client, `${linter}.enable`).start(),
    commands.registerCommand(`${linter}.executeAutofix`, executeAutofix),
    commands.registerCommand(`${linter}.showOutputChannel`, () => {
      client?.outputChannel.show();
    })
  );

  const statusBar = window.createStatusBarItem(0);
  statusBar.text = 'XO';
  // statusBar.command = 'xo.showOutputChannel';
  statusBar.show();
}

export function deactivate() {
  const client = getClient();

  if (!client) {
    return undefined;
  }

  return client.stop();
}
