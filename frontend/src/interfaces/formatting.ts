/**
 * Optional formatting capability for bindings that support rich-text commands.
 * Only DualModeBinding implements this — SourceOnly and PreviewSource do not.
 */

/** Formatting command names the toolbar can invoke */
export type FormattingCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'orderedList'
  | 'codeBlock'
  | 'blockquote'
  | 'horizontalRule'
  | 'link';

/** Active state of all formatting commands at the current cursor position */
export type FormattingState = Record<FormattingCommand, boolean>;

/** Parameters for the link command */
export interface LinkParams {
  href: string;
  text?: string;
}

/**
 * Optional capability interface for bindings that support
 * rich-text formatting commands (WYSIWYG mode).
 *
 * Check with: isFormattingCapable(binding)
 */
export interface IFormattingCapability {
  /** Execute a formatting command */
  executeCommand(command: FormattingCommand, params?: LinkParams): void;

  /** Get the set of commands available in the current mode */
  getAvailableCommands(): FormattingCommand[];

  /** Subscribe to formatting state changes (fires on every selection/transaction change) */
  onFormattingStateChange(
    callback: (state: FormattingState) => void,
  ): () => void;
}

/** Type guard for IFormattingCapability */
export function isFormattingCapable(
  binding: unknown,
): binding is IFormattingCapability {
  return (
    binding !== null &&
    typeof binding === 'object' &&
    typeof (binding as any).executeCommand === 'function' &&
    typeof (binding as any).getAvailableCommands === 'function' &&
    typeof (binding as any).onFormattingStateChange === 'function'
  );
}

/** All available formatting commands */
export const ALL_FORMATTING_COMMANDS: readonly FormattingCommand[] = [
  'bold',
  'italic',
  'strike',
  'code',
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'orderedList',
  'codeBlock',
  'blockquote',
  'horizontalRule',
  'link',
];

/** Create an empty FormattingState (all false) */
export function emptyFormattingState(): FormattingState {
  return Object.fromEntries(
    ALL_FORMATTING_COMMANDS.map((cmd) => [cmd, false]),
  ) as FormattingState;
}
