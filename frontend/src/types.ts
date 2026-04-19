export type EditorMode = 'wysiwyg' | 'source';
export type EditorFormat = 'markdown' | 'html';
export type EditorTheme = 'light' | 'dark';

export interface CollaborationConfig {
  enabled: boolean;
  roomName: string;
  providerUrl: string;
  user: {
    name: string;
    color: string;
  };
}
