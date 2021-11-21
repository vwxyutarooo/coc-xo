import {
  DiagnosticCollection,
  Disposable,
  NotificationType,
  RequestType,
  TextDocumentIdentifier,
  Uri,
  WorkspaceFolder,
} from 'coc.nvim';
import { linter } from '../constants';

export namespace Is {
  const toString = Object.prototype.toString;

  export function boolean(value: any): value is boolean {
    return value === true || value === false;
  }

  export function string(value: any): value is string {
    return toString.call(value) === '[object String]';
  }

  // eslint-disable-next-line @typescript-eslint/ban-types
  export function objectLiteral(value: any): value is object {
    return value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object';
  }
}

export interface ValidateItem {
  language: string;
  autoFix?: boolean;
}

export namespace ValidateItem {
  export function is(item: any): item is ValidateItem {
    const candidate = item as ValidateItem;
    return (
      candidate && Is.string(candidate.language) && (Is.boolean(candidate.autoFix) || candidate.autoFix === void 0)
    );
  }
}

export interface LegacyDirectoryItem {
  directory: string;
  changeProcessCWD: boolean;
}

export namespace LegacyDirectoryItem {
  export function is(item: any): item is LegacyDirectoryItem {
    const candidate = item as LegacyDirectoryItem;
    return candidate && Is.string(candidate.directory) && Is.boolean(candidate.changeProcessCWD);
  }
}

enum ModeEnum {
  auto = 'auto',
  location = 'location',
}

namespace ModeEnum {
  export function is(value: string): value is ModeEnum {
    return value === ModeEnum.auto || value === ModeEnum.location;
  }
}

export interface ModeItem {
  mode: ModeEnum;
}

export namespace ModeItem {
  export function is(item: any): item is ModeItem {
    const candidate = item as ModeItem;
    return candidate && ModeEnum.is(candidate.mode);
  }
}

export interface DirectoryItem {
  directory: string;
  '!cwd'?: boolean;
}

export namespace DirectoryItem {
  export function is(item: any): item is DirectoryItem {
    const candidate = item as DirectoryItem;
    return (
      candidate && Is.string(candidate.directory) && (Is.boolean(candidate['!cwd']) || candidate['!cwd'] === undefined)
    );
  }
}

export interface PatternItem {
  pattern: string;
  '!cwd'?: boolean;
}

export namespace PatternItem {
  export function is(item: any): item is PatternItem {
    const candidate = item as PatternItem;
    return (
      candidate && Is.string(candidate.pattern) && (Is.boolean(candidate['!cwd']) || candidate['!cwd'] === undefined)
    );
  }
}

type RunValues = 'onType' | 'onSave';

interface CodeActionSettings {
  disableRuleComment: {
    enable: boolean;
    location: 'separateLine' | 'sameLine';
  };
  showDocumentation: {
    enable: boolean;
  };
}

export enum CodeActionsOnSaveMode {
  all = 'all',
  problems = 'problems',
}

export namespace CodeActionsOnSaveMode {
  export function from(value: string | undefined | null): CodeActionsOnSaveMode {
    if (value === undefined || value === null) {
      return CodeActionsOnSaveMode.all;
    }
    switch (value.toLowerCase()) {
      case CodeActionsOnSaveMode.problems:
        return CodeActionsOnSaveMode.problems;
      default:
        return CodeActionsOnSaveMode.all;
    }
  }
}

interface CodeActionsOnSaveSettings {
  enable: boolean;
  mode: CodeActionsOnSaveMode;
}

export enum Validate {
  on = 'on',
  off = 'off',
  probe = 'probe',
}

export enum ESLintSeverity {
  off = 'off',
  warn = 'warn',
  error = 'error',
}

export namespace ESLintSeverity {
  export function from(value: string | undefined | null): ESLintSeverity {
    if (value === undefined || value === null) {
      return ESLintSeverity.off;
    }
    switch (value.toLowerCase()) {
      case ESLintSeverity.off:
        return ESLintSeverity.off;
      case ESLintSeverity.warn:
        return ESLintSeverity.warn;
      case ESLintSeverity.error:
        return ESLintSeverity.error;
      default:
        return ESLintSeverity.off;
    }
  }
}

export enum ConfirmationSelection {
  deny = 1,
  disable = 2,
  allow = 3,
  alwaysAllow = 4,
}

export interface ConfigurationSettings {
  validate: Validate;
  packageManager: 'npm' | 'yarn' | 'pnpm';
  codeAction: CodeActionSettings;
  codeActionOnSave: CodeActionsOnSaveSettings;
  format: boolean;
  quiet: boolean;
  onIgnoredFiles: ESLintSeverity;
  options: any | undefined;
  run: RunValues;
  nodePath: string | null;
  workspaceFolder: WorkspaceFolder | undefined;
  workingDirectory: ModeItem | DirectoryItem | undefined;
}

export interface NoESLintState {
  global?: boolean;
  workspaces?: { [key: string]: boolean };
}

export enum Status {
  ok = 1,
  warn = 2,
  error = 3,
  confirmationPending = 4,
  executionDisabled = 5,
  executionDenied = 6,
}

export interface StatusParams {
  uri: string;
  state: Status;
}

export namespace StatusNotification {
  export const type = new NotificationType<StatusParams>(`${linter}/status`);
}

interface NoConfigParams {
  message: string;
  document: TextDocumentIdentifier;
}

interface NoConfigResult {}

export namespace NoConfigRequest {
  export const type = new RequestType<NoConfigParams, NoConfigResult, void>(`${linter}/noConfig`);
}

interface NoESLintLibraryParams {
  source: TextDocumentIdentifier;
}

interface NoESLintLibraryResult {}

export namespace NoESLintLibraryRequest {
  export const type = new RequestType<NoESLintLibraryParams, NoESLintLibraryResult, void>(`${linter}/noLibrary`);
}

interface OpenESLintDocParams {
  url: string;
}

interface OpenESLintDocResult {}

export namespace OpenESLintDocRequest {
  export const type = new RequestType<OpenESLintDocParams, OpenESLintDocResult, void>(`${linter}/openDoc`);
}

interface ProbeFailedParams {
  textDocument: TextDocumentIdentifier;
}

export namespace ProbeFailedRequest {
  export const type = new RequestType<ProbeFailedParams, void, void>(`${linter}/probeFailed`);
}

export interface ESLintExecutionState {
  libs: { [key: string]: boolean };
}

export interface ExecutionParams {
  scope: 'local' | 'global';
  libraryPath: string;
}

export interface ConfirmExecutionParams extends ExecutionParams {
  uri: string;
}

export enum ConfirmExecutionResult {
  denied = 1,
  confirmationPending = 2,
  disabled = 3,
  approved = 4,
}

export namespace ConfirmExecutionResult {
  export function toStatus(value: ConfirmExecutionResult): Status {
    switch (value) {
      case ConfirmExecutionResult.denied:
        return Status.executionDenied;
      case ConfirmExecutionResult.confirmationPending:
        return Status.confirmationPending;
      case ConfirmExecutionResult.disabled:
        return Status.executionDisabled;
      case ConfirmExecutionResult.approved:
        return Status.ok;
    }
  }
}

export namespace ConfirmExecution {
  export const type = new RequestType<ConfirmExecutionParams, ConfirmExecutionResult, void>(
    `${linter}/confirmESLintExecution`
  );
}

export namespace ShowOutputChannel {
  export const type = new NotificationType(`${linter}/showOutputChannel`);
}

export type ExecutionInfo = {
  params: ExecutionParams;
  result: ConfirmExecutionResult;
  editorErrorUri: Uri | undefined;
  diagnostics: DiagnosticCollection;
  codeActionProvider: Disposable | undefined;
};

export type ResourceInfo = {
  status: Status;
  executionInfo: ExecutionInfo | undefined;
};
