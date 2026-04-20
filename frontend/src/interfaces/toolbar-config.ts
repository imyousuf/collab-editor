/**
 * Configuration types for the built-in toolbar and status bar.
 */
import type { FormattingCommand } from './formatting.js';

/** Groups of buttons that can be shown/hidden independently */
export type ToolbarGroup = 'mode-switcher' | 'formatting';

export interface ToolbarConfig {
  /** Show/hide the entire toolbar. Default: true */
  visible?: boolean;

  /** Toolbar position relative to editor. Default: 'top' */
  position?: 'top' | 'bottom';

  /** Which button groups to show. Default: all groups */
  groups?: ToolbarGroup[];

  /** Specific formatting commands to include (whitelist).
   *  If omitted, all available commands are shown. */
  formattingCommands?: FormattingCommand[];

  /** Whether to show the mode switcher buttons. Default: true */
  showModeSwitcher?: boolean;
}

export interface StatusBarConfig {
  /** Show/hide the status bar. Default: true */
  visible?: boolean;

  /** Show connection status indicator. Default: true */
  showConnectionStatus?: boolean;

  /** Show user identity. Default: true */
  showUserIdentity?: boolean;
}
