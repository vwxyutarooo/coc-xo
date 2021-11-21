import { commands, disposeAll, StatusBarItem, Task, TaskOptions, Uri, window, workspace } from 'coc.nvim';
import { Disposable } from 'coc.nvim';
import { linter } from '../constants';
import { findEslint } from './utils';

const errorRegex = /^(.+):(\d+):(\d+):\s*(.+?)\s\[(\w+)\/(.*)\]/;

export default class EslintTask implements Disposable {
  private disposables: Disposable[] = [];
  public static readonly id: string = `${linter}.lintProject`;
  public static readonly startTexts: string[] = [
    'Starting compilation in watch mode',
    'Starting incremental compilation',
  ];
  private statusItem: StatusBarItem;
  private task: Task;

  public constructor() {
    this.statusItem = window.createStatusBarItem(1, { progress: true });
    const task = (this.task = workspace.createTask('XO'));
    this.disposables.push(
      commands.registerCommand(EslintTask.id, async () => {
        const opts = await this.getOptions();
        const started = await this.start(opts);
        if (started) {
          this.statusItem.text = 'compiling';
          this.statusItem.isProgress = true;
          this.statusItem.show();
          workspace.nvim.call('setqflist', [[]], true);
        }
      })
    );
    task.onExit((code) => {
      if (code != 0) {
        window.showMessage(`Eslint found issues`, 'warning');
      }
      this.onStop();
    });
    task.onStdout((lines) => {
      for (const line of lines) {
        this.onLine(line);
      }
    });
    task.onStderr((lines) => {
      window.showMessage(`TSC error: ` + lines.join('\n'), 'error');
    });
    this.disposables.push(
      Disposable.create(() => {
        task.dispose();
      })
    );
  }

  //   private async check(): Promise<void> {
  //     let running = await this.task.running
  //     if (running) await this.task.stop()
  //   }
  //
  private async start(options: TaskOptions): Promise<boolean> {
    return await this.task.start(options);
  }

  private onStop(): void {
    this.statusItem.hide();
  }

  private onLine(line: string): void {
    const ms = line.match(errorRegex);
    if (!ms) return;
    const fullpath = ms[1];
    const uri = Uri.file(fullpath).toString();
    const doc = workspace.getDocument(uri);
    const bufnr = doc ? doc.bufnr : null;
    const item = {
      filename: fullpath,
      lnum: Number(ms[2]),
      col: Number(ms[3]),
      text: `${ms[4]} [${ms[6]}]`,
      type: /error/i.test(ms[5]) ? 'E' : 'W',
    } as any;
    if (bufnr) item.bufnr = bufnr;
    workspace.nvim.call('setqflist', [[item], 'a']);
  }
  public async getOptions(): Promise<TaskOptions> {
    const root = Uri.parse(workspace.workspaceFolder!.uri).fsPath;
    const cmd = await findEslint(root);
    const config = workspace.getConfiguration(linter);
    const args = config.get<string[]>('lintTask.options', ['.']);
    return {
      cmd,
      args: args.concat(['-f', 'unix', '--no-color']),
      cwd: root,
    };
  }

  public dispose(): void {
    disposeAll(this.disposables);
  }
}
