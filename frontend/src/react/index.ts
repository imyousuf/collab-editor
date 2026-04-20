import { createComponent } from '@lit/react';
import React from 'react';
import { MultiEditor } from '../multi-editor.js';

export const MultiEditorReact = createComponent({
  tagName: 'multi-editor',
  elementClass: MultiEditor,
  react: React,
  events: {
    onEditorChange: 'editor-change',
    onModeChange: 'mode-change',
    onEditorSave: 'editor-save',
    onCollabStatus: 'collab-status',
    onBeforeModeChange: 'before-mode-change',
    onDocumentChange: 'document-change',
  },
});
