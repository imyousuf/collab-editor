/**
 * Configuration types for the built-in toolbar and status bar.
 */
import type { FormattingCommand } from './formatting.js';

/** Groups of buttons that can be shown/hidden independently */
export type ToolbarGroup =
  | 'mode-switcher'
  | 'formatting'
  | 'document-switcher'
  | 'blame'
  | 'comments';

/** A document entry for the built-in document switcher */
export interface DocumentEntry {
  /** Unique identifier (used as the option value) */
  id: string;
  /** Display name shown in the dropdown */
  name: string;
}

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

  /** Whether to show the document switcher. Default: true when documents are provided */
  showDocumentSwitcher?: boolean;
}

/** Collaborator info from Yjs awareness */
export interface CollaboratorInfo {
  name: string;
  color: string;
  image?: string;
}

export interface StatusBarConfig {
  /** Show/hide the status bar. Default: true */
  visible?: boolean;

  /** Show connection status indicator. Default: true */
  showConnectionStatus?: boolean;

  /** Show user identity. Default: true */
  showUserIdentity?: boolean;

  /** Show collaborator presence indicators. Default: true */
  showPresence?: boolean;

  /** Show version history controls. Default: true when versions are available */
  showVersionHistory?: boolean;

  /** Show the comments sidebar control. Default: true when comments are available. */
  showCommentsSidebar?: boolean;

  /** Show the Suggest-Mode status pill while suggesting. Default: true */
  showSuggestStatus?: boolean;
}
